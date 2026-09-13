#!/usr/bin/env bash
# Restauración interactiva DB-only. No inicia dependencias ni toca volúmenes/uploads.
set -Eeuo pipefail

usage() {
  printf '%s\n' 'Uso: bash scripts/restore-data.sh [archivo.tar.gz]' \
    'Sin argumento propone el .tar.gz más reciente de backups/data o imports (por mtime).' \
    'Requiere Docker Compose, Python 3 y PostgreSQL ya disponible; --help no usa Docker.' \
    'Valida archivo y .sha256 opcional; sin checksum exige aceptación explícita.' \
    'Backup actual obligatorio por defecto; omitirlo exige escribir SIN RESPALDO.' \
    'Valida el custom exacto sin ejecutar SQL; NO equivale a ensayo/reconciliación.' \
    'Solo DB: uploads con archivos bloquean la operación (web no tiene montaje).' \
    'No ejecuta migrate/seed, no borra volúmenes. Un fallo deja web detenida.'
}
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}
confirm() {
  local answer
  printf '%s [s/N]: ' "$1" >&2
  IFS= read -r answer || return 1
  [[ "$answer" == s || "$answer" == S ]]
}
compose() { docker compose --project-directory "$APP_DIR" -f "$APP_DIR/docker-compose.yml" "$@"; }
db() { docker exec -i "$DB_ID" "$@"; }
psql_db() { db psql -X -v ON_ERROR_STOP=1 -U "$DB_USER" "$@"; }
cleanup() {
  local code=$?
  trap - EXIT ERR INT TERM HUP
  if ((code != 0 && QUIESCED)); then
    # También cubre die, señales y errores durante start/healthcheck.
    compose stop web >/dev/null 2>&1 || printf 'URGENTE: no se pudo detener web; detenela manualmente.\n' >&2
    printf 'Restauración NO completada. Web debe quedar detenida; no reiniciar sin diagnóstico.\n' >&2
  fi
  if [[ -n "$WORK_DIR" ]]; then
    python3 - "$WORK_DIR" <<'PY'
import os, sys
# Solo los dos archivos propios; nunca borrado recursivo de rutas del archivo.
root = sys.argv[1]
for name in ('postgres.dump', 'source.tar.gz'):
    path = os.path.join(root, name)
    if os.path.isfile(path):
        os.unlink(path)
os.rmdir(root)
PY
  fi
  exit "$code"
}
prepare_archive() {
  local checksum_status
  checksum_status="$(
    python3 - "$ARCHIVE" "$WORK_DIR" <<'PY'
import hashlib, os, pathlib, re, shutil, sys, tarfile
source, work = sys.argv[1:]
# Congelar bytes antes de validar para no restaurar otra versión del archivo.
snapshot = os.path.join(work, 'source.tar.gz')
shutil.copyfile(source, snapshot)
checksum = source + '.sha256'
try:
    text = pathlib.Path(checksum).read_text().strip()
except FileNotFoundError:
    print('missing')
else:
    # Un único hash, opcionalmente seguido por el nombre del archivo seleccionado.
    match = re.fullmatch(r'([0-9a-fA-F]{64})(?:[ \t]+\*?([^\r\n]+))?', text)
    if not match or (match[2] and match[2] not in (os.path.basename(source), source)):
        raise SystemExit('ERROR: formato/nombre del .sha256 inválido; se espera un único hash SHA256.')
    with open(snapshot, 'rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest()
    if digest.lower() != match[1].lower():
        raise SystemExit('ERROR: checksum SHA256 no coincide.')
with tarfile.open(snapshot, 'r:gz') as archive:
    seen, dumps = set(), []
    for member in archive.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or '\\' in member.name:
            raise SystemExit('ERROR: ruta insegura en archivo.')
        if not (member.isdir() or member.isfile()) or member.issparse():
            raise SystemExit('ERROR: enlaces/dispositivos/archivos especiales no permitidos.')
        normalized = str(path)
        if normalized in seen:
            raise SystemExit('ERROR: miembro duplicado en archivo.')
        seen.add(normalized)
        if 'uploads' in path.parts and member.isfile():
            raise SystemExit('ERROR: contiene uploads. Web no tiene montaje persistente verificado; '
                             'no se restaurará la DB. Definí y verificá recuperación real de uploads '
                             'con el responsable de almacenamiento antes de continuar.')
        if path.name == 'postgres.dump' and member.isfile():
            dumps.append(member)
    if len(dumps) != 1:
        raise SystemExit('ERROR: se requiere exactamente un postgres.dump regular.')
    # Nunca extract/extractall: copiar únicamente el payload a un nombre fijo propio.
    with archive.extractfile(dumps[0]) as src, open(os.path.join(work, 'postgres.dump'), 'xb') as dst:
        if src.read(5) != b'PGDMP':
            raise SystemExit('ERROR: postgres.dump no es formato custom PostgreSQL.')
        dst.write(b'PGDMP')
        shutil.copyfileobj(src, dst)
PY
  )" || return $?
  if [[ "$checksum_status" == missing ]]; then
    confirm 'ADVERTENCIA: no hay SHA256 para la copia congelada. ¿Aceptar integridad no autenticada?' || die 'Cancelado sin checksum.'
  fi
}
validate_custom_dump() {
  # Sin conexión a DB: recorrer también los datos, no solamente el índice TOC.
  db pg_restore --list <"$1" >/dev/null || return $?
  db pg_restore --exit-on-error --no-owner --no-privileges --file=/dev/null <"$1"
}
package_safety_archive() {
  python3 - "$1" "$2" <<'PY'
import os, sys, tarfile
source, destination = sys.argv[1:]
with open(source, 'rb') as dump, tarfile.open(destination, 'w:gz') as archive:
    member = tarfile.TarInfo('postgres.dump')
    member.size = os.path.getsize(source)
    member.mode = 0o600
    archive.addfile(member, dump)
PY
}
main() {
  if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
    usage
    return
  fi
  (($# <= 1)) || die 'Se acepta un solo archivo.'
  [[ "${1:-}" != -* ]] || die 'Opción desconocida; consultá --help.'
  local SCRIPT_DIR
  SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
  local cmd
  for cmd in docker python3 mktemp; do command -v "$cmd" >/dev/null || die "Falta $cmd"; done
  ARCHIVE="${1:-}"
  if [[ -z "$ARCHIVE" ]]; then
    ARCHIVE="$(
      python3 - "$APP_DIR" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
files = [p for d in ('backups/data', 'imports') for p in (root / d).glob('*.tar.gz') if p.is_file()]
print(max(files, key=lambda p: (p.stat().st_mtime_ns, str(p))) if files else '')
PY
    )"
  fi
  [[ -f "$ARCHIVE" && "$ARCHIVE" == *.tar.gz ]] || die 'No hay respaldo .tar.gz válido.'
  printf 'Respaldo seleccionado: %s\n' "$ARCHIVE"
  confirm '¿Usar este respaldo? (el más reciente puede ser posterior al incidente)' || die 'Cancelado.'
  WORK_DIR='' QUIESCED=0
  trap cleanup EXIT
  trap 'exit 1' ERR
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  umask 077
  WORK_DIR="$(mktemp -d -t restore-data.XXXXXXXX)"
  prepare_archive
  # Resolver un único contenedor existente por servicio y fijar el ID de postgres.
  DB_ID="$(compose ps -q postgres)"
  WEB_ID="$(compose ps -aq web)"
  [[ -n "$DB_ID" && "$DB_ID" != *$'\n'* && -n "$WEB_ID" && "$WEB_ID" != *$'\n'* ]] || die 'Se requiere exactamente un postgres activo y un web existente.'
  PROJECT="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$DB_ID")"
  [[ -n "$PROJECT" && "$PROJECT" != '<no value>' ]] || die 'Postgres sin proyecto Compose.'
  [[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$WEB_ID")" == "$PROJECT" ]] || die 'Servicios en proyectos diferentes.'
  # Nunca imprimir password ni DATABASE_URL; leer solo usuario/base del contenedor.
  DB_USER="$(db sh -c 'printf "%s" "$POSTGRES_USER"')"
  DB_NAME="$(db sh -c 'printf "%s" "$POSTGRES_DB"')"
  [[ "$DB_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ && "$DB_NAME" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || die 'Usuario/base vacíos o identificadores no soportados.'
  [[ "$DB_NAME" != postgres && "$DB_NAME" != template0 && "$DB_NAME" != template1 ]] || die 'No se permite restaurar bases administrativas.'
  WEB_STATE="$(docker inspect --format '{{.State.Status}}' "$WEB_ID")"
  [[ "$WEB_STATE" == running || "$WEB_STATE" == exited || "$WEB_STATE" == created ]] || die 'Estado de web no soportado.'
  validate_custom_dump "$WORK_DIR/postgres.dump"
  psql_db -d postgres -Atc 'SELECT 1;' >/dev/null
  printf 'Destino: proyecto=%s servicio=postgres contenedor=%s usuario=%s base=%s\nWeb: %s (%s)\n' "$PROJECT" "$DB_ID" "$DB_USER" "$DB_NAME" "$WEB_ID" "$WEB_STATE"
  printf '%s\n' 'Custom congelado validado sin ejecutar SQL. NO prueba restaurabilidad ni reconcilia inventario.' \
    'restore-drill.sh usa postgres.sql: NO valida este postgres.dump. Aquí se reemplaza ese requisito por validación sin ejecución del custom exacto.'
  confirm '¿Aceptar los límites de esta validación, respaldo confiable y otros escritores detenidos? El dump puede ejecutar SQL' || die 'Falta autorización de validación limitada.'
  local safety=1 answer expected
  if ! confirm '¿Crear respaldo de seguridad actual? (recomendado y requerido por defecto)'; then
    printf 'ADVERTENCIA: perdés la vuelta atrás. Escribí SIN RESPALDO para omitir; Enter cancela: ' >&2
    IFS= read -r answer || die 'Cancelado.'
    [[ "$answer" == 'SIN RESPALDO' ]] || die 'Cancelado: no se omite backup por defecto.'
    safety=0
  fi
  expected="RESTAURAR $PROJECT/postgres/$DB_NAME"
  printf 'Se reemplazará SOLO esa base, nunca volúmenes. Escribí exactamente: %s\n> ' "$expected" >&2
  IFS= read -r answer || die 'Cancelado.'
  [[ "$answer" == "$expected" ]] || die 'Confirmación incorrecta.'
  # A partir de aquí cualquier salida fallida mantiene web detenida, incluso die.
  QUIESCED=1
  compose stop web
  [[ "$(docker inspect --format '{{.State.Running}}' "$WEB_ID")" == false ]] || die 'Web sigue activa.'
  if ((safety)); then
    mkdir -p "$APP_DIR/backups/data"
    local safety_path safety_archive
    safety_path="$(mktemp "$APP_DIR/backups/data/pre-restore.XXXXXXXX.dump")"
    printf 'Backup de seguridad DB-only: %s (si falla, queda parcial; no usarlo).\n' "$safety_path"
    db pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc >"$safety_path"
    validate_custom_dump "$safety_path"
    safety_archive="$(mktemp "$APP_DIR/backups/data/pre-restore.XXXXXXXX.tar.gz")"
    printf 'Empaquetando respaldo: %s (si falla, queda parcial; no usarlo). Dump validado: %s\n' "$safety_archive" "$safety_path"
    package_safety_archive "$safety_path" "$safety_archive" || die "Falló el empaquetado; DB sin reemplazar. Dump validado conservado: $safety_path; archivo parcial: $safety_archive"
    printf 'Backup de seguridad validado y empaquetado para restore-data.sh: %s\n' "$safety_archive"
  fi
  # psql sustituye variables en stdin, NO dentro de -c. Literales e identificadores separados.
  psql_db -d postgres -v target="$DB_NAME" -v owner="$DB_USER" <<'SQL'
ALTER DATABASE :"target" WITH ALLOW_CONNECTIONS false;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'target' AND pid <> pg_backend_pid();
DROP DATABASE :"target" WITH (FORCE);
CREATE DATABASE :"target" OWNER :"owner" TEMPLATE template0;
SQL
  db pg_restore --exit-on-error --no-owner --no-privileges -U "$DB_USER" -d "$DB_NAME" <"$WORK_DIR/postgres.dump"
  local tables
  tables="$(psql_db -d "$DB_NAME" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';")"
  [[ "$tables" =~ ^[0-9]+$ ]] && ((tables > 0)) || die 'Restauración sin tablas públicas verificables.'
  printf 'DB restaurada: %s tablas públicas. Falta reconciliación de inventario y pruebas operativas manuales.\n' "$tables"
  if [[ "$WEB_STATE" == running ]]; then
    compose start web
    local health i
    for ((i = 0; i < 60; i++)); do
      health="$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}sin-healthcheck{{end}}' "$WEB_ID")"
      case "$health" in
      running/healthy)
        printf 'Web saludable; esto NO verifica login ni integridad operativa.\n'
        return 0
        ;;
      running/starting | running/unhealthy) sleep 2 ;;
      *) die "Web no verificada: $health" ;;
      esac
    done
    die 'Web no alcanzó healthy en 120 segundos; queda detenida.'
  fi
  printf 'Web estaba detenida: se conserva ese estado; disponibilidad NO verificada.\n'
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi

#!/usr/bin/env bash
# ==========================================================================
# Ensayo de restauración — Droguería Específica
#
# Restaura un respaldo en un PostgreSQL AISLADO y descartable, y verifica que
# la copia sirva: conteos por tabla y reconciliación del inventario contra el
# ledger. No toca ningún dato real en ningún momento.
#
# Sirve para las dos cosas que importan:
#   1. El ensayo trimestral (decisión D7). Un respaldo que nunca se restauró
#      es una suposición, no un respaldo.
#   2. El paso previo OBLIGATORIO de una restauración real: probar el dump
#      acá ANTES de tocar producción. Ver RUNBOOK-RESTAURACION.md.
#
# Uso: scripts/restore-drill.sh --dump=<archivo> [opciones]
# ==========================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

DUMP_PATH="${DUMP_PATH:-}"
DRILL_PORT="${DRILL_PORT:-55433}"
DRILL_DB="${DRILL_DB:-restaurada}"
DRILL_DB_USER="drill"
DRILL_DB_PASSWORD="drill"
KEEP="${KEEP:-0}"
ALLOW_DRIFT="${ALLOW_DRIFT:-0}"

# Puertos que este script NO puede usar jamás: son de datos que sí importan.
PORT_DESARROLLO=5433
PORT_HARNESS_TESTS=55432

COMPOSE_FILE="${APP_DIR}/docker-compose.restore-drill.yml"
PROJECT="dgdrill-$(date +%Y%m%d-%H%M%S)-$$"
WORK_DIR=""

usage() {
  cat <<'EOF'
Uso: scripts/restore-drill.sh --dump=<archivo> [opciones]

Restaura un respaldo en un PostgreSQL aislado y descartable, y lo verifica.
NO toca la base de desarrollo ni la de producción ni el harness de tests.

Formatos aceptados en --dump:
  *.tar.gz   archivo de scripts/backup-data.sh (usa su postgres.sql interno)
  *.sql      dump plano de pg_dump
  *.sql.gz   dump plano comprimido

Opciones:
  --dump=RUTA      Respaldo a restaurar. Obligatorio.
  --port=N         Puerto del PostgreSQL del ensayo. Por defecto 55433.
  --keep           No destruye el entorno al terminar (para inspeccionarlo).
  --allow-drift    Acepta que el reconciliador encuentre lotes descuadrados.
                   Úsalo solo con copias anteriores al ledger, sabiendo por qué.
  --help           Muestra esta ayuda.

Variables equivalentes:
  DUMP_PATH= DRILL_PORT= DRILL_DB= KEEP=1 ALLOW_DRIFT=1
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dump=*)  DUMP_PATH="${1#*=}" ;;
    --port=*)  DRILL_PORT="${1#*=}" ;;
    --keep)    KEEP=1 ;;
    --allow-drift) ALLOW_DRIFT=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "ERROR: opción desconocida: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

require_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: comando requerido no disponible: $1" >&2; exit 1; }
}

require_command docker
require_command pnpm

if [ -z "${DUMP_PATH}" ]; then
  echo "ERROR: falta --dump=<archivo>." >&2
  usage >&2
  exit 1
fi

if [ ! -f "${DUMP_PATH}" ]; then
  echo "ERROR: no existe el respaldo: ${DUMP_PATH}" >&2
  exit 1
fi

DUMP_PATH="$(cd -- "$(dirname -- "${DUMP_PATH}")" && pwd -P)/$(basename -- "${DUMP_PATH}")"

# Guarda dura: el ensayo NUNCA comparte puerto con datos que importan. No es
# paranoia, es que un ensayo que pisa la base de desarrollo deja de ser ensayo.
if [ "${DRILL_PORT}" = "${PORT_DESARROLLO}" ] || [ "${DRILL_PORT}" = "${PORT_HARNESS_TESTS}" ]; then
  echo "ERROR: el puerto ${DRILL_PORT} es de desarrollo (${PORT_DESARROLLO}) o del harness de tests (${PORT_HARNESS_TESTS})." >&2
  echo "       Elegí otro con --port=N." >&2
  exit 1
fi

# Guarda dura: si la app apunta a ese mismo destino, el ensayo restauraría
# encima de la operación real.
if [ -f "${APP_DIR}/.env" ] && grep -qE "^DATABASE_URL=.*[:/]${DRILL_PORT}/" "${APP_DIR}/.env" 2>/dev/null; then
  echo "ERROR: el DATABASE_URL de ${APP_DIR}/.env usa el puerto ${DRILL_PORT}." >&2
  exit 1
fi

cd "${APP_DIR}"

compose() {
  DRILL_PORT="${DRILL_PORT}" DRILL_DB_USER="${DRILL_DB_USER}" \
    DRILL_DB_PASSWORD="${DRILL_DB_PASSWORD}" \
    docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" "$@"
}

psql_drill() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${DRILL_DB_USER}" "$@"
}

teardown() {
  local code=$?
  if [ "${KEEP}" = "1" ]; then
    echo ""
    echo "Entorno CONSERVADO (--keep). Para entrar:"
    echo "  psql postgresql://${DRILL_DB_USER}:${DRILL_DB_PASSWORD}@127.0.0.1:${DRILL_PORT}/${DRILL_DB}"
    echo "Para destruirlo:"
    echo "  docker compose -p ${PROJECT} -f ${COMPOSE_FILE} down -v"
  else
    echo ""
    echo "Destruyendo el entorno del ensayo (contenedor y volumen)..."
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  [ -n "${WORK_DIR}" ] && [ -d "${WORK_DIR}" ] && rm -rf -- "${WORK_DIR}"
  exit "${code}"
}
trap teardown EXIT

echo "=== Ensayo de restauración ==="
echo "respaldo : ${DUMP_PATH}"
echo "proyecto : ${PROJECT}   (volumen nuevo, se destruye al terminar)"
echo "destino  : 127.0.0.1:${DRILL_PORT}/${DRILL_DB}"
echo ""

# --- 1. Extraer el SQL del respaldo -------------------------------------
WORK_DIR="$(mktemp -d)"
SQL_FILE="${WORK_DIR}/restore.sql"

echo "[1/5] Extrayendo el SQL del respaldo..."
case "${DUMP_PATH}" in
  *.tar.gz)
    # El archivo de backup-data.sh trae <nombre>/postgres.sql adentro.
    tar -xzf "${DUMP_PATH}" -C "${WORK_DIR}"
    found="$(find "${WORK_DIR}" -name postgres.sql -type f | head -n1)"
    if [ -z "${found}" ]; then
      echo "ERROR: el archivo no contiene postgres.sql: ${DUMP_PATH}" >&2
      exit 1
    fi
    mv -- "${found}" "${SQL_FILE}"
    ;;
  *.sql.gz) gunzip -c "${DUMP_PATH}" >"${SQL_FILE}" ;;
  *.sql)    cp -- "${DUMP_PATH}" "${SQL_FILE}" ;;
  *)
    echo "ERROR: formato no soportado: ${DUMP_PATH}" >&2
    echo "       Se aceptan .tar.gz, .sql y .sql.gz" >&2
    exit 1
    ;;
esac
echo "      SQL de $(wc -l <"${SQL_FILE}" | tr -d ' ') líneas."

# --- 2. Levantar el PostgreSQL aislado ----------------------------------
echo "[2/5] Levantando PostgreSQL aislado..."
# El progreso de compose va a stderr y no aporta nada cuando sale bien; se
# guarda y solo se muestra si falla, que es cuando sí importa.
if ! UP_LOG="$(compose up -d --wait 2>&1)"; then
  echo "${UP_LOG}" >&2
  echo "ERROR: no se pudo levantar el PostgreSQL del ensayo." >&2
  exit 1
fi
echo "      Listo en el puerto ${DRILL_PORT}."

# --- 3. Restaurar -------------------------------------------------------
echo "[3/5] Restaurando con ON_ERROR_STOP=1..."
psql_drill -d postgres -q -c "DROP DATABASE IF EXISTS \"${DRILL_DB}\";" >/dev/null 2>&1
psql_drill -d postgres -q -c "CREATE DATABASE \"${DRILL_DB}\";" >/dev/null
# ON_ERROR_STOP=1 es lo que convierte esto en una verificación: sin él, psql
# informa los errores y sigue, y el ensayo termina "bien" con una copia rota.
# Se descarta stdout (el dump imprime resultados de `set_config` y demás) pero
# NO stderr: ahí es donde aparecerían los errores que tienen que frenar esto.
psql_drill -d "${DRILL_DB}" -q <"${SQL_FILE}" >/dev/null
echo "      Restauración sin errores."

# --- 4. Conteos por tabla -----------------------------------------------
echo "[4/5] Conteos por tabla:"
# Conteo EXACTO, no la estimación de pg_stat_user_tables (que sin ANALYZE
# previo puede decir 0 sobre una tabla recién restaurada y llena).
psql_drill -d "${DRILL_DB}" -P pager=off -c "
  SELECT table_name AS tabla,
         (xpath('/row/c/text()',
                query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name),
                             false, true, '')))[1]::text::bigint AS filas
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ORDER BY table_name;"

TOTAL_TABLAS="$(psql_drill -d "${DRILL_DB}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';" | tr -d '[:space:]')"
if [ "${TOTAL_TABLAS}" = "0" ]; then
  echo "ERROR: la copia restaurada no tiene ni una tabla. El respaldo no sirve." >&2
  exit 1
fi
echo "      ${TOTAL_TABLAS} tablas restauradas."

# --- 5. Reconciliación del inventario -----------------------------------
echo "[5/5] Reconciliando inventario contra el ledger (solo lectura)..."
# El singleton de Prisma exige AUTH_SECRET de 32+ caracteres aunque acá no se
# autentique a nadie. Se genera uno de usar y tirar.
set +e
DATABASE_URL="postgresql://${DRILL_DB_USER}:${DRILL_DB_PASSWORD}@127.0.0.1:${DRILL_PORT}/${DRILL_DB}" \
  AUTH_SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '\n')" \
  pnpm --filter @drogueria/web db:reconcile
RECONCILE_CODE=$?
set -e

echo ""
if [ "${RECONCILE_CODE}" -eq 0 ]; then
  echo "=== ENSAYO OK: la copia restaura y el inventario cuadra. ==="
  exit 0
fi

if [ "${ALLOW_DRIFT}" = "1" ]; then
  echo "=== ENSAYO OK CON SALVEDAD ==="
  echo "La copia restaura y se lee, pero el reconciliador encontró lotes"
  echo "descuadrados y se aceptó con --allow-drift. Eso es esperable solo en"
  echo "copias anteriores al ledger. Dejá la lista asentada en el reporte."
  exit 0
fi

echo "=== ENSAYO FALLIDO ==="
echo "La copia restauró, pero el inventario NO cuadra contra el ledger."
echo "Si el respaldo es anterior al ledger, repetí con --allow-drift."
echo "Si no lo es, ese descuadre viajó dentro del respaldo: no restaures"
echo "esta copia en producción sin entender la lista de arriba."
exit 1

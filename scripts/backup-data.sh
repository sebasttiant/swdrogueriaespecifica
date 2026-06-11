#!/usr/bin/env bash
# ==========================================================================
# Backup operativo — Droguería Específica
#
# Genera un backup completo de datos operativos sin detener contenedores:
# - dump PostgreSQL en formato custom y SQL plano
# - metadata de Docker Compose y Git
# - uploads persistentes si existen
# ==========================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

DB_SERVICE="${DB_SERVICE:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-${APP_DIR}/backups/data}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_NAME="drogueria-data-backup-${TIMESTAMP}"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"
ARCHIVE_PATH="${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"
UPLOADS_DIR="${APP_DIR}/apps/web/public/uploads"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: comando requerido no disponible: $1" >&2
    exit 1
  fi
}

redact_secrets() {
  perl -pe '
    s#(postgres(?:ql)?://[^:\s]+:)[^@\s]+(@)#$1<redacted>$2#g;
    s#^(\s*(?:-\s*)?(?:[A-Z0-9_]*_)?(?:PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL|DB_URL|AUTH_SECRET)\s*[:=]\s*).*$#$1<redacted>#i;
  '
}

cd "${APP_DIR}"

require_command docker
require_command tar
require_command perl

if [ ! -f "${APP_DIR}/.env" ]; then
  echo "ERROR: falta ${APP_DIR}/.env. No se ejecuta backup sin configuración de entorno." >&2
  exit 1
fi

mkdir -p "${BACKUP_PATH}/metadata"

cleanup_partial_backup() {
  local exit_code=$?
  if [ "${exit_code}" -ne 0 ] && [ -d "${BACKUP_PATH}" ] && [ ! -f "${ARCHIVE_PATH}" ]; then
    echo "ERROR: backup incompleto; eliminando carpeta parcial: ${BACKUP_PATH}" >&2
    rm -rf -- "${BACKUP_PATH}"
  fi
  exit "${exit_code}"
}
trap cleanup_partial_backup EXIT

echo "Creando backup en: ${BACKUP_PATH}"

{
  echo "backup_name=${BACKUP_NAME}"
  echo "created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "app_dir=${APP_DIR}"
  echo "db_service=${DB_SERVICE}"
} >"${BACKUP_PATH}/metadata/backup-info.txt"

docker compose ps >"${BACKUP_PATH}/metadata/docker-compose-ps.txt"
docker compose config | redact_secrets >"${BACKUP_PATH}/metadata/docker-compose-config.redacted.yml"

if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  {
    echo "branch=$(git branch --show-current 2>/dev/null || true)"
    echo "commit=$(git rev-parse HEAD 2>/dev/null || true)"
    echo "status_porcelain=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  } >"${BACKUP_PATH}/metadata/git.txt"
fi

echo "Generando dump PostgreSQL custom..."
docker compose exec -T "${DB_SERVICE}" sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  >"${BACKUP_PATH}/postgres.dump"

echo "Generando dump PostgreSQL SQL plano..."
docker compose exec -T "${DB_SERVICE}" sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' \
  >"${BACKUP_PATH}/postgres.sql"

if [ -d "${UPLOADS_DIR}" ]; then
  echo "Copiando uploads persistentes..."
  mkdir -p "${BACKUP_PATH}/uploads"
  tar -C "${UPLOADS_DIR}" -cf - . | tar -C "${BACKUP_PATH}/uploads" -xf -
else
  echo "No existe ${UPLOADS_DIR}; se omite copia de uploads."
fi

echo "Empaquetando backup..."
tar -C "${BACKUP_DIR}" -czf "${ARCHIVE_PATH}" "${BACKUP_NAME}"
rm -rf -- "${BACKUP_PATH}"

trap - EXIT

echo "Backup OK: ${ARCHIVE_PATH}"

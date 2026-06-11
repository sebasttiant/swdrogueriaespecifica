#!/usr/bin/env bash
# ==========================================================================
# Reset de datos operativos — Droguería Específica
#
# Limpia datos de operación diaria preservando usuarios y catálogo/productos.
# También borra lotes/stock (`product_batches`): el catálogo queda, el stock no.
# Ejecuta backup previo por defecto y exige confirmación fuerte.
# ==========================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

DB_SERVICE="${DB_SERVICE:-postgres}"
CONFIRM_RESET="${CONFIRM_RESET:-}"
SKIP_BACKUP="${SKIP_BACKUP:-0}"
DRY_RUN="${DRY_RUN:-0}"

cd "${APP_DIR}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: comando requerido no disponible: docker" >&2
  exit 1
fi

if [ ! -f "${APP_DIR}/.env" ]; then
  echo "ERROR: falta ${APP_DIR}/.env. No se ejecuta reset sin configuración de entorno." >&2
  exit 1
fi

if [ "${DRY_RUN}" = "1" ]; then
  echo "DRY_RUN=1: se probará el SQL dentro de una transacción y se hará ROLLBACK."
elif [ "${CONFIRM_RESET}" != "YES" ]; then
  echo "ADVERTENCIA: esto BORRA datos operativos y conserva usuarios/productos."
  echo "También borra lotes/stock físico registrados en product_batches."
  echo "Tablas afectadas: audit_logs, inventory_entries, missing_items, pendings, product_batches"
  read -r -p "Para continuar escribí exactamente BORRAR DATOS: " confirmation
  if [ "${confirmation}" != "BORRAR DATOS" ]; then
    echo "Reset cancelado."
    exit 1
  fi
fi

if [ "${DRY_RUN}" = "1" ]; then
  echo "DRY_RUN=1: se omite backup previo porque no se persistirán cambios."
elif [ "${SKIP_BACKUP}" != "1" ]; then
  echo "Ejecutando backup previo..."
  "${SCRIPT_DIR}/backup-data.sh"
else
  echo "SKIP_BACKUP=1 definido; se omite backup previo."
fi

if [ "${DRY_RUN}" = "1" ]; then
  echo "Probando limpieza de datos operativos en PostgreSQL (sin persistir cambios)..."
else
  echo "Limpiando datos operativos en PostgreSQL..."
fi

docker compose exec -T -e DRY_RUN="${DRY_RUN}" "${DB_SERVICE}" sh -lc 'psql -v ON_ERROR_STOP=1 -v dry_run="$DRY_RUN" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
BEGIN;

\echo Conteos antes del reset:
SELECT 'audit_logs' AS table_name, count(*) AS rows FROM audit_logs
UNION ALL SELECT 'inventory_entries', count(*) FROM inventory_entries
UNION ALL SELECT 'missing_items', count(*) FROM missing_items
UNION ALL SELECT 'pendings', count(*) FROM pendings
UNION ALL SELECT 'product_batches', count(*) FROM product_batches
ORDER BY table_name;

TRUNCATE TABLE
  audit_logs,
  inventory_entries,
  missing_items,
  pendings,
  product_batches
RESTART IDENTITY CASCADE;

\echo Conteos despues del reset:
SELECT 'audit_logs' AS table_name, count(*) AS rows FROM audit_logs
UNION ALL SELECT 'inventory_entries', count(*) FROM inventory_entries
UNION ALL SELECT 'missing_items', count(*) FROM missing_items
UNION ALL SELECT 'pendings', count(*) FROM pendings
UNION ALL SELECT 'product_batches', count(*) FROM product_batches
ORDER BY table_name;
\if :dry_run
  \echo DRY_RUN activo: se revierte la transaccion. No se borró nada.
  ROLLBACK;
\else
  COMMIT;
\endif
SQL

if [ "${DRY_RUN}" = "1" ]; then
  echo "DRY_RUN OK. No se borró nada."
else
  echo "Reset operativo OK. Usuarios y productos/catalogo fueron preservados."
fi

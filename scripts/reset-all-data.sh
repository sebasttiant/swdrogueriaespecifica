#!/usr/bin/env bash
# ==========================================================================
# Reset TOTAL de datos — Droguería Específica
#
# Deja la droguería en blanco conservando SOLO las cuentas de usuario: sus
# correos, roles y contraseñas siguen funcionando.
#
# Diferencia con `reset-operational-data.sh`: ese conserva el catálogo de
# productos. Este también lo borra. Sirve para arrancar de cero —una demo, una
# capacitación, el paso a producción— sin tener que volver a crear los usuarios.
#
# Los proveedores y laboratorios se CONSERVAN por defecto: son el directorio de
# a quién se le compra, no operación del día, y rehacerlo es trabajo manual. Con
# `--incluir-proveedores` también se borran.
#
# Ejecuta backup previo por defecto y exige confirmación fuerte.
# ==========================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

DB_SERVICE="${DB_SERVICE:-postgres}"
CONFIRM_RESET="${CONFIRM_RESET:-}"
SKIP_BACKUP="${SKIP_BACKUP:-0}"
DRY_RUN="${DRY_RUN:-0}"
INCLUDE_SUPPLIERS="${INCLUDE_SUPPLIERS:-0}"

CONFIRMATION_PHRASE="BORRAR TODO MENOS USUARIOS"

usage() {
  cat <<'EOF'
Uso: scripts/reset-all-data.sh [--dry-run] [--yes] [--skip-backup] [--incluir-proveedores]

Deja la droguería EN BLANCO conservando solo las cuentas de usuario.

Vacía:
- audit_logs
- inventory_entries
- missing_items
- missing_reports
- pendings
- product_batches
- products

Por CASCADE también se vacían las tablas que dependen de esas
(entregas de pendientes, asignaciones y reservas de inventario).

Conserva:
- users            (correos, roles y contraseñas siguen funcionando)
- suppliers        (salvo --incluir-proveedores)
- laboratories     (salvo --incluir-proveedores)

Opciones:
  --dry-run              Prueba la limpieza dentro de una transacción y revierte todo.
  --yes                  Permite ejecución no interactiva; requiere backup salvo --skip-backup.
  --skip-backup          Omite backup previo. No recomendado.
  --incluir-proveedores  Borra además proveedores y laboratorios.
  --help                 Muestra esta ayuda.

Variables equivalentes:
  DRY_RUN=1 CONFIRM_RESET=YES SKIP_BACKUP=1 INCLUDE_SUPPLIERS=1 DB_SERVICE=postgres

Nota: el seed vuelve a crear los productos de demostración en el próximo
deploy. Si querés el catálogo vacío, corré este script DESPUÉS de desplegar.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes) CONFIRM_RESET=YES ;;
    --skip-backup) SKIP_BACKUP=1 ;;
    --incluir-proveedores) INCLUDE_SUPPLIERS=1 ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "ERROR: opción desconocida: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

cd "${APP_DIR}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: comando requerido no disponible: docker" >&2
  exit 1
fi

if [ ! -f "${APP_DIR}/.env" ]; then
  echo "ERROR: falta ${APP_DIR}/.env. No se ejecuta reset sin configuración de entorno." >&2
  exit 1
fi

# Las tablas extra van al final: el orden no importa para TRUNCATE, pero
# mantenerlas aparte deja claro qué agrega la opción.
TABLES='
  audit_logs,
  inventory_entries,
  missing_items,
  missing_reports,
  pendings,
  product_batches,
  products'

if [ "${INCLUDE_SUPPLIERS}" = "1" ]; then
  TABLES="${TABLES},
  suppliers,
  laboratories"
fi

if [ "${DRY_RUN}" = "1" ]; then
  echo "DRY_RUN=1: se probará el SQL dentro de una transacción y se hará ROLLBACK."
elif [ "${CONFIRM_RESET}" != "YES" ]; then
  echo "ADVERTENCIA: esto BORRA TODA la operación Y el catálogo de productos."
  echo "Se conservan ÚNICAMENTE las cuentas de usuario."
  if [ "${INCLUDE_SUPPLIERS}" = "1" ]; then
    echo "Además se borrarán proveedores y laboratorios (--incluir-proveedores)."
  else
    echo "Proveedores y laboratorios se conservan."
  fi
  echo "Se ejecutará backup previo automáticamente antes de borrar."
  read -r -p "Para continuar escribí exactamente ${CONFIRMATION_PHRASE}: " confirmation
  if [ "${confirmation}" != "${CONFIRMATION_PHRASE}" ]; then
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
  echo "Probando limpieza total en PostgreSQL (sin persistir cambios)..."
else
  echo "Limpiando TODOS los datos salvo usuarios en PostgreSQL..."
fi

# El SQL se arma con las tablas elegidas y se pasa por stdin, igual que
# `reset-operational-data.sh`. `\if :dry_run` decide COMMIT o ROLLBACK dentro de
# la misma transacción, así el ensayo recorre exactamente el mismo camino.
docker compose exec -T -e DRY_RUN="${DRY_RUN}" "${DB_SERVICE}" \
  sh -lc 'psql -v ON_ERROR_STOP=1 -v dry_run="$DRY_RUN" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<SQL
BEGIN;

\echo Usuarios ANTES del reset (deben seguir igual al final):
SELECT role, count(*) AS usuarios FROM users GROUP BY role ORDER BY role;

TRUNCATE TABLE ${TABLES}
RESTART IDENTITY CASCADE;

\echo Conteos DESPUES del reset:
SELECT 'pendings' AS tabla, count(*) AS filas FROM pendings
UNION ALL SELECT 'missing_items', count(*) FROM missing_items
UNION ALL SELECT 'missing_reports', count(*) FROM missing_reports
UNION ALL SELECT 'inventory_entries', count(*) FROM inventory_entries
UNION ALL SELECT 'product_batches', count(*) FROM product_batches
UNION ALL SELECT 'products', count(*) FROM products
UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs
UNION ALL SELECT 'users (conservados)', count(*) FROM users
ORDER BY tabla;

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
  echo "Reset total OK. Las cuentas de usuario fueron preservadas."
  echo "Recordá: el seed recrea los productos de demostración en el próximo deploy."
fi

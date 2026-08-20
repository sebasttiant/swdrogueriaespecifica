#!/usr/bin/env bash
# ==========================================================================
# Seed de datos operativos demo — Droguería Específica
#
# Crea datos realistas y determinísticos para demostración post-reset:
# 10 pendientes + 10 faltantes, con 10 clientes distintos. No requiere Excel.
# Por seguridad corre en DRY_RUN por defecto, y sembrar de verdad exige escribir
# la confirmación a mano: es el único freno entre esto y una base real.
# ==========================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

DB_SERVICE="${DB_SERVICE:-postgres}"
DRY_RUN="${DRY_RUN:-1}"
CONFIRM_IMPORT="${CONFIRM_IMPORT:-}"
SKIP_BACKUP="${SKIP_BACKUP:-0}"

usage() {
  cat <<'EOF'
Uso: scripts/seed-operational-data.sh [--dry-run] [--execute] [--skip-backup]

Siembra datos operativos demo seguros para VPS:
- 10 pendientes con clientes y teléfonos distintos.
- 10 faltantes enlazados a esos pendientes.
- Usa productos activos del catálogo si el nombre coincide.
- Si no existen, crea productos determinísticos IMP-DEMO-*.

El script NO lee archivos Excel y NO ejecuta reset. Para dejar la base limpia,
ejecutá primero pnpm data:reset:operational y luego este seed.

Opciones:
  --dry-run       Prueba la siembra dentro de una transacción y revierte todo.
  --execute       Siembra realmente. Pide la confirmación por teclado y hace
                  backup previo por defecto.
  --skip-backup   Omite backup previo en --execute. No recomendado.
  --help          Muestra esta ayuda.

Atajos pnpm:
  pnpm data:seed:operational:dry   Ensayo sin escribir nada.
  pnpm data:seed:operational       Siembra real; te va a pedir la confirmación.

Variables equivalentes:
  DRY_RUN=0 CONFIRM_IMPORT=YES SKIP_BACKUP=1 DB_SERVICE=postgres
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: comando requerido no disponible: $1" >&2
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --execute)
      DRY_RUN=0
      CONFIRM_IMPORT=YES
      ;;
    --skip-backup)
      SKIP_BACKUP=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: opción desconocida: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

cd "${APP_DIR}"

require_command docker

if [ ! -f "${APP_DIR}/.env" ]; then
  echo "ERROR: falta ${APP_DIR}/.env. No se siembra demo sin configuración de entorno." >&2
  exit 1
fi

if [ "${DRY_RUN}" = "1" ]; then
  echo "DRY_RUN=1: PostgreSQL probará la siembra demo y hará ROLLBACK."
elif [ "${CONFIRM_IMPORT}" != "YES" ]; then
  echo "ERROR: para sembrar realmente usá --execute o CONFIRM_IMPORT=YES." >&2
  exit 1
else
  echo "ADVERTENCIA: esto INSERTA datos demo operativos idempotentes."
  echo "Se crearán 10 pendientes y 10 faltantes; se crearán productos IMP-DEMO-* solo si no hay coincidencia activa en catálogo."
  read -r -p "Para continuar escribí exactamente SEMBRAR DEMO OPERATIVO: " confirmation
  if [ "${confirmation}" != "SEMBRAR DEMO OPERATIVO" ]; then
    echo "Seed demo cancelado."
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

if [ -z "$(docker compose ps -q "${DB_SERVICE}")" ]; then
  echo "ERROR: no se encontró contenedor para el servicio ${DB_SERVICE}." >&2
  exit 1
fi

if [ "${DRY_RUN}" = "1" ]; then
  echo "Probando seed demo operativo en PostgreSQL (sin persistir cambios)..."
else
  echo "Sembrando demo operativo en PostgreSQL..."
fi

docker compose exec -T -e DRY_RUN="${DRY_RUN}" "${DB_SERVICE}" sh -lc 'psql -v ON_ERROR_STOP=1 -v dry_run="$DRY_RUN" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
BEGIN;

CREATE TEMP TABLE demo_operational_data (
  demo_no integer PRIMARY KEY,
  product_name text NOT NULL,
  demo_product_code text NOT NULL,
  quantity integer NOT NULL,
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  need_note text NOT NULL,
  promised_offset_days integer NOT NULL
) ON COMMIT DROP;

INSERT INTO demo_operational_data (
  demo_no,
  product_name,
  demo_product_code,
  quantity,
  customer_name,
  customer_phone,
  need_note,
  promised_offset_days
) VALUES
  (1, 'Losartan 50 mg caja x 30 tabletas', 'IMP-DEMO-001', 2, 'María Fernanda Ríos', '3005550101', 'Cliente hipertenso solicita continuidad del tratamiento.', 1),
  (2, 'Metformina 850 mg caja x 30 tabletas', 'IMP-DEMO-002', 1, 'Carlos Andrés Mejía', '3005550102', 'Retira familiar autorizado en la tarde.', 1),
  (3, 'Atorvastatina 20 mg caja x 30 tabletas', 'IMP-DEMO-003', 1, 'Diana Marcela Torres', '3005550103', 'Confirmar disponibilidad antes de las 5 p.m.', 2),
  (4, 'Levotiroxina 50 mcg caja x 50 tabletas', 'IMP-DEMO-004', 3, 'Jorge Iván Salazar', '3005550104', 'Paciente requiere misma concentración formulada.', 2),
  (5, 'Omeprazol 20 mg caja x 14 cápsulas', 'IMP-DEMO-005', 2, 'Patricia Gómez López', '3005550105', 'Pendiente para entregar junto con fórmula completa.', 3),
  (6, 'Amlodipino 5 mg caja x 30 tabletas', 'IMP-DEMO-006', 1, 'Luis Fernando Castro', '3005550106', 'Cliente pide llamada cuando llegue el producto.', 3),
  (7, 'Sertralina 50 mg caja x 30 tabletas', 'IMP-DEMO-007', 1, 'Natalia Andrea Pérez', '3005550107', 'Verificar proveedor por disponibilidad limitada.', 4),
  (8, 'Ibuprofeno 400 mg caja x 20 tabletas', 'IMP-DEMO-008', 4, 'Roberto Sánchez Díaz', '3005550108', 'Compra para botiquín familiar; acepta equivalente.', 4),
  (9, 'Acetaminofén 500 mg caja x 20 tabletas', 'IMP-DEMO-009', 5, 'Mónica Alejandra Vargas', '3005550109', 'Solicita reservar unidades apenas ingresen.', 5),
  (10, 'Loratadina 10 mg caja x 10 tabletas', 'IMP-DEMO-010', 2, 'Andrés Felipe Molina', '3005550110', 'Cliente frecuente; avisar por WhatsApp.', 5);

\echo Conteos antes del seed demo:
SELECT 'products' AS table_name, count(*) AS rows FROM products
UNION ALL SELECT 'pendings', count(*) FROM pendings
UNION ALL SELECT 'missing_items', count(*) FROM missing_items
ORDER BY table_name;

WITH product_candidates AS (
  SELECT DISTINCT
    demo_no,
    product_name,
    demo_product_code
  FROM demo_operational_data data
  WHERE NOT EXISTS (
    SELECT 1
    FROM products product
    WHERE product.active = true
      AND lower(btrim(product.name)) = lower(btrim(data.product_name))
  )
)
INSERT INTO products (id, code, name, unit, "minStock", "reorderQty", active, "createdAt", "updatedAt")
SELECT
  'imp_demo_product_' || lpad(demo_no::text, 3, '0'),
  demo_product_code,
  product_name,
  'unidad',
  0,
  0,
  true,
  now(),
  now()
FROM product_candidates
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  unit = EXCLUDED.unit,
  active = true,
  "updatedAt" = now();

CREATE TEMP TABLE demo_operational_resolved AS
SELECT
  data.*,
  COALESCE(existing_product.id, demo_product.id) AS product_id,
  'imp_demo_pending_' || lpad(data.demo_no::text, 3, '0') AS pending_id,
  'imp_demo_missing_' || lpad(data.demo_no::text, 3, '0') AS missing_id,
  (date_trunc('day', now()) + (data.promised_offset_days || ' days')::interval + interval '10 hours') AS promised_at
FROM demo_operational_data data
LEFT JOIN LATERAL (
  SELECT product.id
  FROM products product
  WHERE product.active = true
    AND lower(btrim(product.name)) = lower(btrim(data.product_name))
  ORDER BY CASE WHEN product.code LIKE 'IMP-DEMO-%' THEN 1 ELSE 0 END, product.id
  LIMIT 1
) existing_product ON true
LEFT JOIN products demo_product ON demo_product.code = data.demo_product_code;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM demo_operational_resolved WHERE product_id IS NULL) THEN
    RAISE EXCEPTION 'No se pudo resolver producto para todos los datos demo';
  END IF;
END $$;

INSERT INTO pendings (
  id,
  "productId",
  quantity,
  status,
  "promisedAt",
  "customerName",
  note,
  "createdById",
  "createdAt",
  "updatedAt"
)
SELECT
  pending_id,
  product_id,
  quantity,
  'PENDIENTE'::"PendingStatus",
  promised_at,
  customer_name,
  concat_ws(' | ', 'Tel: ' || customer_phone, need_note, 'Demo operativo determinístico'),
  NULL,
  now(),
  now()
FROM demo_operational_resolved
ON CONFLICT (id) DO NOTHING;

INSERT INTO missing_items (
  id,
  "productId",
  quantity,
  status,
  "originId",
  "createdById",
  "createdAt",
  "updatedAt"
)
SELECT
  missing_id,
  product_id,
  quantity,
  'FALTANTE'::"MissingItemStatus",
  pending_id,
  NULL,
  now(),
  now()
FROM demo_operational_resolved
ON CONFLICT (id) DO NOTHING;

\echo Filas demo presentes por tipo:
SELECT 'demo_products' AS row_type, count(*) AS rows FROM products WHERE code LIKE 'IMP-DEMO-%'
UNION ALL SELECT 'demo_pendings', count(*) FROM pendings WHERE id LIKE 'imp_demo_pending_%'
UNION ALL SELECT 'demo_missing_items', count(*) FROM missing_items WHERE id LIKE 'imp_demo_missing_%'
ORDER BY row_type;

\echo Conteos despues del seed demo:
SELECT 'products' AS table_name, count(*) AS rows FROM products
UNION ALL SELECT 'pendings', count(*) FROM pendings
UNION ALL SELECT 'missing_items', count(*) FROM missing_items
ORDER BY table_name;

\if :dry_run
  \echo DRY_RUN activo: se revierte la transaccion. No se sembró demo.
  ROLLBACK;
\else
  COMMIT;
\endif
SQL

if [ "${DRY_RUN}" = "1" ]; then
  echo "DRY_RUN OK. No se sembró demo."
else
  echo "Seed demo operativo OK."
fi

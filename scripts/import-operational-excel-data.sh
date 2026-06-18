#!/usr/bin/env bash
# ==========================================================================
# Import de datos operativos desde Excel — Droguería Específica
#
# Lee FALTANTES.xlsx y PENDIENTES 2.0.xlsx con Python estándar (sin paquetes
# externos), genera un TSV temporal e importa productos faltantes, pendientes y
# faltantes en PostgreSQL. Por seguridad corre en DRY_RUN por defecto.
# ==========================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

DB_SERVICE="${DB_SERVICE:-postgres}"
DRY_RUN="${DRY_RUN:-1}"
CONFIRM_IMPORT="${CONFIRM_IMPORT:-}"
SKIP_BACKUP="${SKIP_BACKUP:-0}"
FALTANTES_XLSX="${FALTANTES_XLSX:-/home/sebastian/Documentos/DEV/DROGUERIA ESPECIFICA/DOCUMENTOS/FALTANTES.xlsx}"
PENDIENTES_XLSX="${PENDIENTES_XLSX:-/home/sebastian/Documentos/DEV/DROGUERIA ESPECIFICA/DOCUMENTOS/PENDIENTES 2.0.xlsx}"
IMPORT_TSV=""
CONTAINER_TSV=""

usage() {
  cat <<'EOF'
Uso: scripts/import-operational-excel-data.sh [--dry-run] [--execute] [--skip-backup]

Importa datos realistas desde:
- FALTANTES.xlsx: hoja "faltantess" -> missing_items manuales.
- PENDIENTES 2.0.xlsx: hojas "PENDIENTES", "PENDIENTES FACTURADOS" y
  "LISTA DE ESPERA LAURELES" -> pendings + missing_items enlazados.

El script crea productos faltantes con código determinístico IMP-<hash> cuando
no encuentra un producto activo con el mismo nombre normalizado.

Opciones:
  --dry-run       Genera e intenta la importación dentro de una transacción y revierte.
  --execute       Importa realmente. Exige confirmación fuerte y backup por defecto.
  --skip-backup   Omite backup previo en --execute. No recomendado.
  --help          Muestra esta ayuda.

Variables equivalentes:
  DRY_RUN=0 CONFIRM_IMPORT=YES SKIP_BACKUP=1 DB_SERVICE=postgres
  FALTANTES_XLSX="/ruta/FALTANTES.xlsx"
  PENDIENTES_XLSX="/ruta/PENDIENTES 2.0.xlsx"
EOF
}

cleanup() {
  if [ -n "${IMPORT_TSV}" ] && [ -f "${IMPORT_TSV}" ]; then
    rm -f -- "${IMPORT_TSV}"
  fi
  if [ -n "${CONTAINER_TSV}" ]; then
    docker compose exec -T "${DB_SERVICE}" rm -f -- "${CONTAINER_TSV}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

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
require_command python3

if [ ! -f "${APP_DIR}/.env" ]; then
  echo "ERROR: falta ${APP_DIR}/.env. No se importa sin configuración de entorno." >&2
  exit 1
fi

if [ ! -f "${FALTANTES_XLSX}" ]; then
  echo "ERROR: no existe FALTANTES_XLSX=${FALTANTES_XLSX}" >&2
  exit 1
fi

if [ ! -f "${PENDIENTES_XLSX}" ]; then
  echo "ERROR: no existe PENDIENTES_XLSX=${PENDIENTES_XLSX}" >&2
  exit 1
fi

if [ "${DRY_RUN}" = "1" ]; then
  echo "DRY_RUN=1: se generará el import y PostgreSQL hará ROLLBACK."
elif [ "${CONFIRM_IMPORT}" != "YES" ]; then
  echo "ERROR: para importar realmente usá --execute o CONFIRM_IMPORT=YES." >&2
  exit 1
else
  echo "ADVERTENCIA: esto INSERTA productos IMP-*, pendientes y faltantes operativos."
  echo "Archivos:"
  echo "- ${FALTANTES_XLSX}"
  echo "- ${PENDIENTES_XLSX}"
  read -r -p "Para continuar escribí exactamente IMPORTAR EXCEL OPERATIVO: " confirmation
  if [ "${confirmation}" != "IMPORTAR EXCEL OPERATIVO" ]; then
    echo "Import cancelado."
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

IMPORT_TSV="$(mktemp)"

echo "Leyendo Excel y generando TSV temporal..."
python3 - "${FALTANTES_XLSX}" "${PENDIENTES_XLSX}" "${IMPORT_TSV}" <<'PY'
from __future__ import annotations

import csv
import hashlib
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree as ET
from zipfile import ZipFile

NS = {
    "a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
BOGOTA = timezone(timedelta(hours=-5))


def colnum(ref: str) -> int:
    match = re.match(r"([A-Z]+)", ref or "")
    if not match:
        return 0
    value = 0
    for char in match.group(1):
        value = value * 26 + ord(char) - 64
    return value


def clean(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("\xa0", " ")).strip()


def workbook_rows(path: Path) -> Iterable[tuple[str, int, list[str]]]:
    with ZipFile(path) as archive:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = [
                "".join(t.text or "" for t in item.findall(".//a:t", NS))
                for item in root.findall("a:si", NS)
            ]

        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        relmap = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels}

        for sheet in workbook.findall("a:sheets/a:sheet", NS):
            name = sheet.attrib.get("name", "")
            rel_id = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
            target = relmap[rel_id]
            sheet_path = "xl/" + target.lstrip("/") if not target.startswith("xl/") else target
            root = ET.fromstring(archive.read(sheet_path))
            for row in root.findall("a:sheetData/a:row", NS):
                row_number = int(row.attrib.get("r", "0") or 0)
                values: list[str] = []
                last_index = 0
                for cell in row.findall("a:c", NS):
                    index = colnum(cell.attrib.get("r", ""))
                    values.extend([""] * max(index - last_index - 1, 0))
                    last_index = index
                    raw = cell.find("a:v", NS)
                    value = "" if raw is None or raw.text is None else raw.text
                    if cell.attrib.get("t") == "s" and value:
                        value = shared[int(value)]
                    values.append(clean(value))
                if any(values):
                    yield name, row_number, values


def quantity_from_text(*values: str) -> int:
    text = " ".join(clean(value).lower() for value in values)
    match = re.search(r"(?:pte|pt|pen|pend|p)\s*([0-9]+)", text)
    if not match:
        match = re.search(r"\b([0-9]+)\b", text)
    if not match:
        return 1
    return max(int(match.group(1)), 1)


def promised_at(note: str) -> str:
    text = note.lower()
    now = datetime.now(BOGOTA).replace(minute=0, second=0, microsecond=0)
    days = 1 if "mañana" in text or "manana" in text else 0 if "hoy" in text else 2
    local = (now + timedelta(days=days)).replace(hour=17)
    return local.astimezone(timezone.utc).isoformat()


def row_id(kind: str, source: str, sheet: str, row_number: int, product: str, customer: str) -> str:
    seed = "|".join([kind, source, sheet, str(row_number), product.lower(), customer.lower()])
    return f"imp_{kind}_{hashlib.sha1(seed.encode()).hexdigest()[:24]}"


faltantes_path = Path(sys.argv[1])
pendientes_path = Path(sys.argv[2])
output_path = Path(sys.argv[3])
rows: list[list[str]] = []

for sheet, row_number, values in workbook_rows(faltantes_path):
    if sheet != "faltantess" or row_number <= 1:
        continue
    product = clean(values[0] if len(values) > 0 else "")
    marker = clean(values[1] if len(values) > 1 else "")
    if not product or product.lower().startswith("seguir apuntando"):
        continue
    quantity = quantity_from_text(marker)
    note = clean(" | ".join(value for value in values[1:5] if clean(value)))
    missing_id = row_id("missing", faltantes_path.name, sheet, row_number, product, "")
    rows.append(["missing", missing_id, "", product, str(quantity), "", note, faltantes_path.name, sheet, str(row_number), ""])

pending_sheets = {"PENDIENTES", "PENDIENTES FACTURADOS", "LISTA DE ESPERA LAURELES"}
for sheet, row_number, values in workbook_rows(pendientes_path):
    if sheet not in pending_sheets:
        continue
    primary = values + [""] * 12
    if clean(primary[4]) and not clean(primary[4]).replace(".", "", 1).isdigit():
        product, qty_text, customer, phone = primary[4], primary[5], primary[6], primary[7]
        note_parts = [primary[0], primary[1], primary[2], primary[3], primary[8], primary[9], primary[10], primary[11]]
    elif clean(primary[8]) and not clean(primary[8]).replace(".", "", 1).isdigit():
        product, qty_text, customer, phone = primary[8], primary[9], primary[10], primary[11]
        note_parts = [primary[0], primary[1], primary[2], primary[3], primary[4], primary[5], primary[6], primary[7]]
    else:
        continue
    product = clean(product)
    if not product or product.lower().startswith("revisado"):
        continue
    quantity = quantity_from_text(qty_text)
    customer = clean(customer)
    note = clean(" | ".join(value for value in [qty_text, phone, *note_parts] if clean(value)))
    pending_id = row_id("pending", pendientes_path.name, sheet, row_number, product, customer)
    missing_id = row_id("missing", pendientes_path.name, sheet, row_number, product, customer)
    rows.append(["pending", pending_id, missing_id, product, str(quantity), customer, note, pendientes_path.name, sheet, str(row_number), promised_at(note)])

with output_path.open("w", newline="", encoding="utf-8") as handle:
    writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
    for row in rows:
        writer.writerow(row)

print(f"Registros preparados: {len(rows)}")
print(f"Pendientes: {sum(1 for row in rows if row[0] == 'pending')}")
print(f"Faltantes manuales: {sum(1 for row in rows if row[0] == 'missing')}")
PY

echo "Resumen del TSV generado:"
python3 - "${IMPORT_TSV}" <<'PY'
import csv
import sys
from collections import Counter

with open(sys.argv[1], encoding="utf-8", newline="") as handle:
    rows = list(csv.reader(handle, delimiter="\t"))
counts = Counter(row[0] for row in rows)
products = {row[3].strip().lower() for row in rows if len(row) > 3 and row[3].strip()}
print(f"- filas TSV: {len(rows)}")
print(f"- pendientes: {counts['pending']}")
print(f"- faltantes manuales: {counts['missing']}")
print(f"- productos únicos candidatos: {len(products)}")
PY

if [ "${DRY_RUN}" = "1" ]; then
  echo "Probando import en PostgreSQL (sin persistir cambios)..."
else
  echo "Importando datos en PostgreSQL..."
fi

CONTAINER_TSV="/tmp/drogueria-operational-import.tsv"
DB_CONTAINER_ID="$(docker compose ps -q "${DB_SERVICE}")"

if [ -z "${DB_CONTAINER_ID}" ]; then
  echo "ERROR: no se encontró contenedor para el servicio ${DB_SERVICE}." >&2
  exit 1
fi

docker compose cp "${IMPORT_TSV}" "${DB_SERVICE}:${CONTAINER_TSV}"

docker compose exec -T -e DRY_RUN="${DRY_RUN}" "${DB_SERVICE}" sh -lc 'psql -v ON_ERROR_STOP=1 -v dry_run="$DRY_RUN" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
BEGIN;

CREATE TEMP TABLE operational_excel_import (
  record_type text NOT NULL,
  record_id text NOT NULL,
  linked_missing_id text,
  product_name text NOT NULL,
  quantity_text text NOT NULL,
  customer_name text,
  note text,
  source_file text NOT NULL,
  source_sheet text NOT NULL,
  source_row text NOT NULL,
  promised_at text
) ON COMMIT DROP;

\copy operational_excel_import FROM '/tmp/drogueria-operational-import.tsv' WITH (FORMAT csv, DELIMITER E'\t')

\echo Conteos antes del import:
SELECT 'products' AS table_name, count(*) AS rows FROM products
UNION ALL SELECT 'pendings', count(*) FROM pendings
UNION ALL SELECT 'missing_items', count(*) FROM missing_items
ORDER BY table_name;

\echo Registros preparados por tipo:
SELECT record_type, count(*) AS rows
FROM operational_excel_import
GROUP BY record_type
ORDER BY record_type;

WITH product_candidates AS (
  SELECT DISTINCT ON (lower(btrim(product_name)))
    lower(btrim(product_name)) AS normalized_name,
    btrim(product_name) AS product_name
  FROM operational_excel_import
  WHERE btrim(product_name) <> ''
  ORDER BY lower(btrim(product_name)), btrim(product_name)
), missing_products AS (
  SELECT candidate.*
  FROM product_candidates candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM products product
    WHERE lower(btrim(product.name)) = candidate.normalized_name
  )
)
INSERT INTO products (id, code, name, unit, "minStock", "reorderQty", active, "createdAt", "updatedAt")
SELECT
  'imp_product_' || md5(normalized_name),
  'IMP-' || upper(left(md5(normalized_name), 12)),
  product_name,
  'unidad',
  0,
  0,
  true,
  now(),
  now()
FROM missing_products
ON CONFLICT DO NOTHING;

CREATE TEMP TABLE operational_excel_resolved AS
SELECT
  imported.*,
  product.id AS product_id,
  greatest(NULLIF(regexp_replace(imported.quantity_text, '[^0-9]', '', 'g'), '')::integer, 1) AS quantity
FROM operational_excel_import imported
JOIN LATERAL (
  SELECT id
  FROM products
  WHERE lower(btrim(name)) = lower(btrim(imported.product_name))
  ORDER BY CASE WHEN code LIKE 'IMP-%' THEN 1 ELSE 0 END, id
  LIMIT 1
) product ON true;

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
  record_id,
  product_id,
  quantity,
  'PENDIENTE'::"PendingStatus",
  promised_at::timestamptz AT TIME ZONE 'UTC',
  NULLIF(btrim(customer_name), ''),
  NULLIF(btrim(concat_ws(' | ', note, 'Importado desde ' || source_file || ' / ' || source_sheet || ' fila ' || source_row)), ''),
  NULL,
  now(),
  now()
FROM operational_excel_resolved
WHERE record_type = 'pending'
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
  CASE WHEN record_type = 'pending' THEN linked_missing_id ELSE record_id END,
  product_id,
  quantity,
  'FALTANTE'::"MissingItemStatus",
  CASE WHEN record_type = 'pending' THEN record_id ELSE NULL END,
  NULL,
  now(),
  now()
FROM operational_excel_resolved
WHERE record_type IN ('pending', 'missing')
ON CONFLICT (id) DO NOTHING;

\echo Conteos despues del import:
SELECT 'products' AS table_name, count(*) AS rows FROM products
UNION ALL SELECT 'pendings', count(*) FROM pendings
UNION ALL SELECT 'missing_items', count(*) FROM missing_items
ORDER BY table_name;

\if :dry_run
  \echo DRY_RUN activo: se revierte la transaccion. No se importó nada.
  ROLLBACK;
\else
  COMMIT;
\endif
SQL

if [ "${DRY_RUN}" = "1" ]; then
  echo "DRY_RUN OK. No se importó nada."
else
  echo "Import operativo OK."
fi

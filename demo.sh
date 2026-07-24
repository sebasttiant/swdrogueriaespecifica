#!/usr/bin/env bash
set -Eeuo pipefail

# ==========================================================================
# Droguería Específica — cargar DATOS DE DEMO
#
# Puebla el circuito completo para mostrarlo a los encargados: un vendedor
# (juan@drogueria.demo / OPERADOR), catálogo con laboratorios y stock,
# pendientes con estado de gestión, faltantes en distintos estados y un reporte
# esperando revisión. Toca las 5 mejoras del sprint.
#
# Idempotente (upsert): re-ejecutarlo no duplica. Pensado para correr sobre una
# base recién blanqueada (./blank.sh) o recién seedeada. Agrega datos ficticios,
# así que pide confirmación salvo que se pase FORCE=si.
#
# Uso:   ./demo.sh          (pide confirmar)
#        FORCE=si ./demo.sh (sin prompt)
# ==========================================================================

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
DB_SERVICE="${DB_SERVICE:-postgres}"
SEED_SERVICE="${SEED_SERVICE:-seed}"
cd "$APP_DIR"

if [ ! -f "$APP_DIR/.env" ]; then
  echo "ERROR: falta $APP_DIR/.env"
  exit 1
fi

echo "==> Esto carga DATOS DE DEMO (ficticios) en la base."
if [ "${FORCE:-}" != "si" ]; then
  read -r -p "    Escribí SI para continuar: " answer
  if [ "$answer" != "SI" ]; then
    echo "    Cancelado. No se tocó nada."
    exit 1
  fi
fi

echo "==> Actualizando la imagen (los scripts viven dentro de ella)..."
docker compose build "$SEED_SERVICE"

echo "==> Asegurando que la base esté arriba..."
docker compose up -d "$DB_SERVICE"
until docker compose exec -T "$DB_SERVICE" sh -lc \
  'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; do
  sleep 2
done

echo "==> Cargando datos de demo..."
docker compose run --rm --no-deps -e CONFIRM_DEMO=si "$SEED_SERVICE" \
  node_modules/.bin/tsx prisma/seed-demo.ts

echo "==> Listo. Entrá a la app y recorré el circuito."

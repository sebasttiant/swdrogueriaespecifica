#!/usr/bin/env bash
set -Eeuo pipefail

# ==========================================================================
# Droguería Específica — BLANQUEO de la base
#
# Borra TODA la operación y el catálogo (pendientes, faltantes, reportes,
# entregas, entradas, productos, laboratorios, proveedores, lotes, auditoría).
# CONSERVA la tabla de usuarios: las cuentas del equipo quedan intactas. Borrar
# usuarios es aparte, a mano, desde la gestión de usuarios (super admin).
#
# DESTRUCTIVO E IRREVERSIBLE. Pide confirmación escrita salvo que se pase
# FORCE=si (para automatización). Corre el script guardado dentro del contenedor
# `seed` (que tiene tsx, Prisma y DATABASE_URL).
#
# Uso:   ./blank.sh          (pide escribir BORRAR)
#        FORCE=si ./blank.sh (sin prompt)
# ==========================================================================

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
DB_SERVICE="${DB_SERVICE:-postgres}"
SEED_SERVICE="${SEED_SERVICE:-seed}"
cd "$APP_DIR"

if [ ! -f "$APP_DIR/.env" ]; then
  echo "ERROR: falta $APP_DIR/.env"
  exit 1
fi

echo "==> Esto BORRA toda la operación y el catálogo. Los USUARIOS se conservan."
if [ "${FORCE:-}" != "si" ]; then
  read -r -p "    Escribí BORRAR para confirmar: " answer
  if [ "$answer" != "BORRAR" ]; then
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

echo "==> Blanqueando (los usuarios se conservan)..."
docker compose run --rm --no-deps -e CONFIRM_WIPE=si "$SEED_SERVICE" \
  node_modules/.bin/tsx prisma/wipe.ts

echo "==> Listo. Base en blanco, usuarios intactos."

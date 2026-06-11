#!/usr/bin/env bash
set -Eeuo pipefail

# ==========================================================================
# Droguería Específica — deploy en VPS
#
# Flujo: backup -> pull -> build -> db up -> migrate -> seed -> web up -> verify
#
# IMPORTANTE: el contenedor `web` es Next.js standalone y NO incluye Prisma/seed.
# Por eso las migraciones y el seed se ejecutan explícitamente desde los targets
# dedicados del Dockerfile (`migrate` y `seed`), igual que el VPS de Reservas en
# cuanto a flujo operativo, pero respetando la arquitectura Docker de este repo.
#
# Acceso final:  http://<ip-vps>:3132   (externo 3132 -> interno 3000)
# ==========================================================================

# APP_DIR se autodetecta desde la ubicación del script (robusto ante cualquier
# ruta de clonado). Se puede sobreescribir con la variable de entorno APP_DIR.
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
BACKUP_DIR="$APP_DIR/backups"
BRANCH="${BRANCH:-main}"
WEB_SERVICE="${WEB_SERVICE:-web}"
DB_SERVICE="${DB_SERVICE:-postgres}"
MIGRATE_SERVICE="${MIGRATE_SERVICE:-migrate}"
SEED_SERVICE="${SEED_SERVICE:-seed}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"   # segundos a esperar a que `web` quede healthy

cd "$APP_DIR"

echo "==> Creating backup..."
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/drogueria-before-deploy-$(date +%Y%m%d-%H%M%S).tar.gz"
tar --exclude='./backups' \
    --exclude='./node_modules' \
    --exclude='./apps/web/node_modules' \
    --exclude='./.next' \
    --exclude='./apps/web/.next' \
    --exclude='./.git' \
    -czf "$BACKUP_FILE" .
echo "Backup created: $BACKUP_FILE"

echo "==> Updating code..."
git fetch origin "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "==> Verificando que exista .env..."
if [ ! -f "$APP_DIR/.env" ]; then
  echo "ERROR: falta $APP_DIR/.env (copialo de env.example y completá los valores)."
  exit 1
fi

echo "==> Building web image..."
# Build the deploy images explicitly. `web` is the runtime image; `migrate` and
# `seed` are one-shot images used below so the runtime container stays minimal.
docker compose build "$WEB_SERVICE" "$MIGRATE_SERVICE" "$SEED_SERVICE"

echo "==> Starting database..."
docker compose up -d "$DB_SERVICE"

echo "==> Waiting for database..."
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
until db_status="$(docker compose ps -q "$DB_SERVICE" | xargs -r docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null)"; [ "$db_status" = "healthy" ] || [ "$db_status" = "running" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "ERROR: '$DB_SERVICE' no llegó a 'healthy/running' (estado: ${db_status:-desconocido}). Últimos logs:"
    docker compose logs --tail=80 "$DB_SERVICE"
    exit 1
  fi
  sleep 2
done
docker compose ps

echo "==> Running Prisma migrations..."
docker compose run --rm --no-deps "$MIGRATE_SERVICE"

echo "==> Running seed without pnpm reinstall..."
docker compose run --rm --no-deps "$SEED_SERVICE"

echo "==> Starting containers..."
# Dependencies already ran explicitly above. `--no-deps` prevents compose from
# re-running migrate/seed through depends_on when recreating the web container.
docker compose up -d --no-deps "$WEB_SERVICE"

echo "==> Waiting for containers..."
docker compose ps

echo "==> Waiting for '$WEB_SERVICE' health (timeout ${HEALTH_TIMEOUT}s)..."
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
until status="$(docker compose ps -q "$WEB_SERVICE" | xargs -r docker inspect -f '{{.State.Health.Status}}' 2>/dev/null)"; [ "$status" = "healthy" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "ERROR: '$WEB_SERVICE' no llegó a 'healthy' (estado: ${status:-desconocido}). Últimos logs:"
    docker compose logs --tail=80 "$WEB_SERVICE"
    exit 1
  fi
  sleep 3
done
echo "    '$WEB_SERVICE' is healthy."

echo "==> Verifying seeded users..."
# La tabla real es "users" (el modelo Prisma User está mapeado con @@map).
# Verificación informativa: nunca debe abortar el deploy si ya está healthy.
docker compose exec -T "$DB_SERVICE" sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select email, role from \"users\" order by role;"' \
  || echo "    (verificación de usuarios omitida — el servicio web ya está healthy)"

echo "==> Final container status:"
docker compose ps

echo "Deploy completed successfully."

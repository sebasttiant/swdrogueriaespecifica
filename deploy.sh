#!/usr/bin/env bash
set -Eeuo pipefail

# ==========================================================================
# Droguería Específica — deploy en VPS
#
# Flujo:  backup -> pull -> build -> up -> wait health -> verify
#
# IMPORTANTE: la orquestación (postgres -> migrate -> seed -> web) la maneja
# docker-compose vía healthchecks y `depends_on`. NO se corren migraciones ni
# seed a mano: la imagen `runner` es Next.js standalone y no incluye prisma/tsx.
# Los servicios one-shot `migrate` y `seed` (targets del Dockerfile) hacen ese
# trabajo solos en cada `docker compose up -d`.
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
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"   # segundos a esperar a que `web` quede healthy

cd "$APP_DIR"

echo "==> Backup del directorio de la app..."
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/drogueria-before-deploy-$(date +%Y%m%d-%H%M%S).tar.gz"
tar --exclude='./backups' \
    --exclude='./node_modules' \
    --exclude='./apps/web/node_modules' \
    --exclude='./.next' \
    --exclude='./apps/web/.next' \
    --exclude='./.git' \
    -czf "$BACKUP_FILE" .
echo "    Backup creado: $BACKUP_FILE"

echo "==> Actualizando código (origin/$BRANCH)..."
git fetch origin "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "==> Verificando que exista .env..."
if [ ! -f "$APP_DIR/.env" ]; then
  echo "ERROR: falta $APP_DIR/.env (copialo de env.example y completá los valores)."
  exit 1
fi

echo "==> Building imágenes (--no-cache)..."
# Reconstruye web/migrate/seed (comparten stages del Dockerfile). postgres usa
# imagen, no build, así que compose lo saltea. Para deploys más rápidos podés
# quitar --no-cache y aprovechar la cache de capas.
docker compose build --no-cache

echo "==> Levantando servicios (postgres -> migrate -> seed -> web)..."
# `up -d` respeta los `depends_on` con condiciones: espera a que migrate y seed
# terminen OK antes de arrancar web. Si seed falla, este comando falla (set -e).
docker compose up -d

echo "==> Estado de los jobs one-shot (migrate/seed deben salir con código 0)..."
for svc in migrate seed; do
  cid="$(docker compose ps -aq "$svc" || true)"
  if [ -z "$cid" ]; then
    echo "    ADVERTENCIA: no se encontró contenedor para '$svc'."
    continue
  fi
  code="$(docker inspect -f '{{.State.ExitCode}}' "$cid" 2>/dev/null || echo 'n/a')"
  echo "    $svc -> exit code $code"
  if [ "$code" != "0" ]; then
    echo "ERROR: '$svc' falló (exit $code). Últimos logs:"
    docker compose logs --tail=80 "$svc"
    exit 1
  fi
done

echo "==> Esperando a que '$WEB_SERVICE' quede healthy (timeout ${HEALTH_TIMEOUT}s)..."
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
until status="$(docker compose ps -q "$WEB_SERVICE" | xargs -r docker inspect -f '{{.State.Health.Status}}' 2>/dev/null)"; [ "$status" = "healthy" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "ERROR: '$WEB_SERVICE' no llegó a 'healthy' (estado: ${status:-desconocido}). Últimos logs:"
    docker compose logs --tail=80 "$WEB_SERVICE"
    exit 1
  fi
  sleep 3
done
echo "    '$WEB_SERVICE' está healthy."

echo "==> Verificando usuarios sembrados..."
# La tabla real es "users" (el modelo Prisma User está mapeado con @@map).
# Verificación informativa: nunca debe abortar el deploy si ya está healthy.
docker compose exec -T "$DB_SERVICE" sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select email, role from \"users\" order by role;"' \
  || echo "    (verificación de usuarios omitida — el servicio web ya está healthy)"

echo "==> Estado final de los contenedores:"
docker compose ps

echo "Deploy completado con éxito -> http://<ip-vps>:3132"

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

# Commit que se va a desplegar. Viaja al contenedor como `APP_COMMIT` y aparece
# en cada evento de diagnóstico, para saber con qué versión corrió un intento.
APP_COMMIT="$(git rev-parse --short HEAD)"
export APP_COMMIT
echo "==> Deploying commit $APP_COMMIT"

echo "==> Building web image..."
# Build the deploy images explicitly. `web` is the runtime image; `migrate` and
# `seed` are one-shot images used below so the runtime container stays minimal.
docker compose build "$WEB_SERVICE" "$MIGRATE_SERVICE" "$SEED_SERVICE"

echo "==> Starting database..."
docker compose up -d "$DB_SERVICE"

# --------------------------------------------------------------------------
# Punto de restauración de la BASE DE DATOS.
#
# El tar de arriba respalda el código, NO los datos: Postgres vive en el volumen
# `postgres_data`, fuera de APP_DIR. Sin este dump, una migración que salga mal
# deja el negocio sin forma de volver atrás — y las migraciones de enum de
# PostgreSQL no se revierten (no existe DROP VALUE), así que el único rollback
# real es restaurar este archivo.
#
# Aborta el deploy si el dump falla: desplegar sin punto de retorno es
# exactamente el riesgo que este paso existe para evitar.
# --------------------------------------------------------------------------
echo "==> Waiting for database before dumping..."
db_deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
until docker compose exec -T "$DB_SERVICE" sh -lc 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$db_deadline" ]; then
    echo "ERROR: la base no aceptó conexiones a tiempo; no se puede respaldar."
    docker compose logs --tail=80 "$DB_SERVICE"
    exit 1
  fi
  sleep 2
done

DB_DUMP_FILE="$BACKUP_DIR/drogueria-db-before-deploy-$(date +%Y%m%d-%H%M%S).sql.gz"
echo "==> Dumping database to $DB_DUMP_FILE ..."
if ! docker compose exec -T "$DB_SERVICE" sh -lc \
       'pg_dump --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
     | gzip > "$DB_DUMP_FILE"; then
  echo "ERROR: falló el respaldo de la base. El deploy se detiene ANTES de migrar."
  rm -f "$DB_DUMP_FILE"
  exit 1
fi

# Un dump vacío o truncado es peor que no tener dump: da una falsa sensación de
# respaldo. Se verifica que el archivo sea un gzip legible y no esté vacío.
if ! gzip -t "$DB_DUMP_FILE" 2>/dev/null || [ ! -s "$DB_DUMP_FILE" ]; then
  echo "ERROR: el respaldo quedó vacío o corrupto ($DB_DUMP_FILE). El deploy se detiene."
  exit 1
fi
echo "    ✓ Respaldo verificado: $DB_DUMP_FILE ($(du -h "$DB_DUMP_FILE" | cut -f1))"
echo "    Para restaurar:  gunzip -c '$DB_DUMP_FILE' | docker compose exec -T $DB_SERVICE sh -lc 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"'"

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

# --------------------------------------------------------------------------
# Chequeos post-deploy (informativos: nunca abortan un deploy ya healthy, pero
# avisan fuerte si algo quedó mal). Cubren lo que un healthcheck genérico no ve:
#   1) que las migraciones del ciclo operativo quedaron aplicadas en la base;
#   2) que /reportes renderiza sin 5xx (el SSR de recharts es el riesgo real).
#
# Se consulta `information_schema` en vez de parsear la salida de `\d`: los
# nombres de columna de Prisma son camelCase y el formato de los meta-comandos
# de psql no es un contrato estable.
# --------------------------------------------------------------------------

# Ejecuta una query y devuelve el resultado sin formato (-tA). Falla con estado
# distinto de cero si no se puede consultar la base.
db_query() {
  docker compose exec -T "$DB_SERVICE" sh -lc \
    "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"$1\"" 2>/dev/null
}

schema_ok=1

check_table() {
  local table="$1"
  local exists
  if ! exists="$(db_query "select to_regclass('public.$table') is not null;")"; then
    echo "    ⚠ No se pudo verificar la tabla '$table'."
    schema_ok=0
    return
  fi
  if [ "$exists" = "t" ]; then
    echo "    ✓ Tabla '$table' presente."
  else
    echo "    ⚠ Falta la tabla '$table' — revisá el paso de migración de arriba."
    schema_ok=0
  fi
}

# $2 es una lista de literales SQL: 'colA','colB'. Reporta las que falten.
check_columns() {
  local table="$1"
  local expected="$2"
  local missing
  if ! missing="$(db_query "select coalesce(string_agg(c, ', '), '') from unnest(array[$expected]) as c where c not in (select column_name from information_schema.columns where table_schema = 'public' and table_name = '$table');")"; then
    echo "    ⚠ No se pudieron verificar las columnas de '$table'."
    schema_ok=0
    return
  fi
  if [ -z "$missing" ]; then
    echo "    ✓ '$table' tiene todas las columnas esperadas."
  else
    echo "    ⚠ '$table' no tiene: $missing — revisá el paso de migración de arriba."
    schema_ok=0
  fi
}

echo "==> Post-deploy: verificando el esquema del ciclo operativo..."
if ! db_query "select 1;" >/dev/null; then
  echo "    (verificación de esquema omitida — no se pudo consultar la base; '$WEB_SERVICE' ya está healthy)"
else
  check_table "pending_deliveries"
  check_table "suppliers"
  check_table "laboratories"
  check_columns "pendings" "'deliveredQuantity','completedAt','cancelledAt','cancelledById','cancelReason'"
  check_columns "missing_items" "'confirmedAt','confirmedById','confirmationNote','orderedAt','orderedById','supplierId','sellerCode'"
  check_columns "products" "'needsReview'"
  # Ciclo de cumplimiento (compra -> bodega -> facturación -> entrega). Si estas
  # faltan, la app arranca igual pero el vendedor nunca ve "disponible para
  # facturar" y las entregas parciales no cierran.
  check_table "inventory_allocations"
  check_table "pending_inventory_reservations"
  check_columns "pendings" "'purchaseStatus','availabilityStatus','customerStatus','inventoryReadyQuantity','reservedInventoryQuantity','invoicedQuantity','contactedAt','contactedById','invoicedAt','invoicedById'"
  check_columns "missing_items" "'receivedQuantity','arrivedAt','arrivedById'"
  check_columns "inventory_entries" "'idempotencyKey','requestFingerprint'"

  if [ "$schema_ok" -eq 1 ]; then
    echo "    ✓ Esquema del ciclo operativo aplicado por completo."
  else
    echo "    ⚠ El esquema quedó incompleto. El deploy sigue porque '$WEB_SERVICE' está healthy,"
    echo "      pero las funciones de entrega/pedido pueden fallar en runtime."
  fi
fi

echo "==> Post-deploy: verificando que /reportes responda sin 5xx..."
# /reportes está tras auth: sin sesión redirige a /login (2xx/3xx = OK). Solo un
# 5xx o un fallo de fetch indican que la página crasheó al renderizar. Usamos el
# fetch de Node dentro del contenedor (mismo mecanismo que el healthcheck).
if reportes_status="$(docker compose exec -T "$WEB_SERVICE" node -e \
     "fetch('http://127.0.0.1:3000/reportes',{redirect:'manual'}).then(r=>{console.log(r.status);process.exit(r.status>=500?1:0)}).catch(()=>{console.log('sin-respuesta');process.exit(1)})" \
     2>/dev/null)"; then
  echo "    ✓ /reportes responde (HTTP $reportes_status)."
else
  echo "    ⚠ /reportes devolvió un problema (HTTP ${reportes_status:-sin-respuesta}). Últimos logs de '$WEB_SERVICE':"
  docker compose logs --tail=40 "$WEB_SERVICE"
fi

# --------------------------------------------------------------------------
# Readiness: ¿la web LLEGA a la base?
#
# El healthcheck de Docker mira `/api/health`, que no toca la base a propósito.
# Eso deja un hueco: un despliegue con la `DATABASE_URL` mal escrita queda
# `healthy` y se ve perfecto hasta que alguien intenta cargar un pendiente.
#
# INFORMATIVO, como los dos chequeos de arriba: nunca aborta un despliegue que
# ya está healthy. Solo lo dice fuerte, que es lo que faltaba.
# --------------------------------------------------------------------------
echo "==> Post-deploy: verificando que la web alcance la base..."
if ready_status="$(docker compose exec -T "$WEB_SERVICE" node -e \
     "fetch('http://127.0.0.1:3000/api/ready').then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>{console.log('sin-respuesta');process.exit(1)})" \
     2>/dev/null)"; then
  echo "    ✓ La web consulta PostgreSQL correctamente (HTTP $ready_status)."
else
  echo "    ⚠ La web NO alcanza la base (HTTP ${ready_status:-sin-respuesta})."
  echo "      El contenedor está healthy igual: /api/health no consulta la base."
  echo "      Revisá DATABASE_URL en el .env y los logs de '$WEB_SERVICE'."
  docker compose logs --tail=40 "$WEB_SERVICE"
fi

echo "==> Final container status:"
docker compose ps

echo "Deploy completed successfully."

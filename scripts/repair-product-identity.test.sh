#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq -- "$expected" "$file" || fail "$file no contiene: $expected"
}

assert_contains apps/web/Dockerfile 'FROM builder AS repair'
assert_contains apps/web/Dockerfile \
  'ENTRYPOINT ["node_modules/.bin/tsx", "prisma/repair-product-identity.ts"]'
assert_contains docker-compose.yml 'target: repair'
assert_contains docker-compose.yml \
  'AUTH_SECRET: ${AUTH_SECRET:?AUTH_SECRET es obligatorio}'
assert_contains docs/runbook-reparacion-identidad-pendientes.md \
  './scripts/run-product-identity-repair.sh repair.json'
assert_contains docs/runbook-reparacion-identidad-pendientes.md \
  'CONFIRM_REPAIR_APPLY=apply-product-identity-repair'
assert_contains apps/web/server/services/product-identity-repair.service.ts \
  'No había cambios pendientes; no se escribió nada.'

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/manifest.json" <<'JSON'
{"actorId":"test","targetProductId":"target","expectedTargetOrionCode":null,"canonicalOrionCode":"A1","duplicateProductIds":[],"pendingIds":[],"missingItemIds":[]}
JSON
cat > "$TMP/hostname" <<'SH'
#!/usr/bin/env bash
printf 'test-host\n'
SH
cat > "$TMP/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*"
SH
chmod +x "$TMP/hostname" "$TMP/docker"

DRY_OUTPUT="$(
  PATH="$TMP:$PATH" DEPLOY_TARGET='test-host' APP_DIR="$ROOT" \
    bash scripts/run-product-identity-repair.sh "$TMP/manifest.json"
)"
printf '%s' "$DRY_OUTPUT" | grep -Fq 'DRY-RUN' || fail 'el wrapper no anuncia dry-run'
printf '%s' "$DRY_OUTPUT" | grep -Fq 'repair --manifest=/app/apps/web/repair.json' || \
  fail 'el wrapper no invoca el servicio repair'

if PATH="$TMP:$PATH" DEPLOY_TARGET='otro-host' APP_DIR="$ROOT" \
  bash scripts/run-product-identity-repair.sh "$TMP/manifest.json" >/dev/null 2>&1; then
  fail 'el wrapper aceptó el host equivocado'
fi
if PATH="$TMP:$PATH" DEPLOY_TARGET='test-host' APP_DIR="$ROOT" \
  bash scripts/run-product-identity-repair.sh "$TMP/manifest.json" --apply >/dev/null 2>&1; then
  fail 'el wrapper aceptó --apply sin confirmación exacta'
fi

POSTGRES_USER='test' \
POSTGRES_PASSWORD='test-only-password' \
POSTGRES_DB='test' \
DATABASE_URL='postgresql://test:test@postgres:5432/test' \
AUTH_SECRET='test-only-secret-with-at-least-32-characters' \
  docker compose config --quiet

printf 'OK: repair CLI container contract\n'

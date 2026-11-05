#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
assert_contains() {
  grep -Fq -- "$2" "$1" || fail "$1 no contiene: $2"
}

assert_contains scripts/run-pending-product-repair.sh 'CONFIRM_REPAIR_APPLY=apply-pending-product-repair'
assert_contains scripts/run-pending-product-repair.sh '--entrypoint node_modules/.bin/tsx'
assert_contains scripts/run-pending-product-repair.sh 'prisma/repair-pending-product.ts'
assert_contains apps/web/server/services/pending-product-repair.service.ts 'AUDIT_ACTIONS.PENDING_UPDATE'
assert_contains apps/web/server/services/pending-product-repair.service.ts 'recordAuditInTransaction'
assert_contains docs/runbook-reparacion-producto-pendiente.md './scripts/run-pending-product-repair.sh'
assert_contains docs/runbook-reparacion-producto-pendiente.md 'CONFIRM_REPAIR_APPLY=apply-pending-product-repair'

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/manifest.json" <<'JSON'
{"repairId":"incident-330-laura-pending-product","actorEmail":"admin@ilasesorias.com","pendingId":"cmw15djdt00ph01qsk9oqssrp","expectedCurrentProductId":"cmw15hzoy00pt01qs7m2g73b8","expectedCurrentProductName":"ATODER CREMA ULTRA HYDRATANTE X 500 ML ref","expectedCurrentProductOrionCode":null,"targetProductId":"cmtvwdmrw00ce01nxpuzhebl8","expectedQuantity":2,"expectedStatus":"PENDIENTE","expectedPurchaseStatus":"SOLICITADO","expectedAvailabilityStatus":"ESPERANDO","expectedCustomerStatus":"POR_CONTACTAR","expectedTargetName":"CITIVITAE 1000 MG X 10 SOBRES","expectedTargetOrionCode":"A33731","reason":"Restore the product confirmed by the original request fingerprint and incident #330."}
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

cat > "$TMP/invalid-manifest.json" <<'JSON'
{}
JSON
set +e
CLI_OUTPUT="$(
  POSTGRES_USER='test' \
  POSTGRES_PASSWORD='test-only-password' \
  POSTGRES_DB='test' \
  DATABASE_URL='postgresql://test:test@localhost:5432/test' \
  AUTH_SECRET='test-only-secret-with-at-least-32-characters' \
    pnpm --filter @drogueria/web exec tsx prisma/repair-pending-product.ts \
      --manifest="$TMP/invalid-manifest.json" 2>&1
)"
CLI_EXIT=$?
set -e
[[ $CLI_EXIT -eq 1 ]] || fail "el CLI inválido salió con $CLI_EXIT en vez de 1"
printf '%s' "$CLI_OUTPUT" | grep -Fq 'necesita "repairId" como texto no vacío' || \
  fail 'el CLI no validó públicamente el manifiesto'

DRY_OUTPUT="$(
  PATH="$TMP:$PATH" DEPLOY_TARGET='test-host' APP_DIR="$ROOT" \
    bash scripts/run-pending-product-repair.sh "$TMP/manifest.json"
)"
printf '%s' "$DRY_OUTPUT" | grep -Fq 'DRY-RUN' || fail 'el wrapper no anuncia dry-run'
printf '%s' "$DRY_OUTPUT" | grep -Fq \
  'repair prisma/repair-pending-product.ts --manifest=/app/apps/web/pending-product-repair.json' || \
  fail 'el wrapper no invoca el CLI de reparación'

if PATH="$TMP:$PATH" DEPLOY_TARGET='wrong-host' APP_DIR="$ROOT" \
  bash scripts/run-pending-product-repair.sh "$TMP/manifest.json" >/dev/null 2>&1; then
  fail 'el wrapper aceptó el host equivocado'
fi
if PATH="$TMP:$PATH" DEPLOY_TARGET='test-host' APP_DIR="$ROOT" \
  bash scripts/run-pending-product-repair.sh "$TMP/manifest.json" --apply >/dev/null 2>&1; then
  fail 'el wrapper aceptó --apply sin confirmación exacta'
fi

APPLY_OUTPUT="$(
  PATH="$TMP:$PATH" DEPLOY_TARGET='test-host' APP_DIR="$ROOT" \
  CONFIRM_REPAIR_APPLY='apply-pending-product-repair' \
    bash scripts/run-pending-product-repair.sh "$TMP/manifest.json" --apply
)"
printf '%s' "$APPLY_OUTPUT" | grep -Fq -- '--apply' || fail 'el wrapper perdió --apply'

printf 'OK: pending-product repair CLI contract\n'

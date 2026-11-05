#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  grep -Fq -- "$2" "$1" || fail "$1 no contiene: $2"
}

assert_contains apps/web/Dockerfile 'FROM builder AS repair-invariant'
assert_contains apps/web/Dockerfile \
  'ENTRYPOINT ["node_modules/.bin/tsx", "prisma/repair-inventory-invariant.ts"]'
assert_contains docker-compose.yml 'target: repair-invariant'
assert_contains docs/runbook-reparacion-invariante-inventario.md \
  'CONFIRM_REPAIR_APPLY=apply-inventory-invariant-repair'

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/hostname" <<'SH'
#!/usr/bin/env bash
printf 'test-host\n'
SH
cat > "$TMP/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*"
SH
chmod +x "$TMP/hostname" "$TMP/docker"
FP="$(printf 'a%.0s' {1..64})"
run() { PATH="$TMP:$PATH" APP_DIR="$ROOT" bash scripts/run-inventory-invariant-repair.sh "$@"; }

DRY="$(DEPLOY_TARGET=test-host run actor-1)"
printf '%s' "$DRY" | grep -Fq 'DRY-RUN' || fail 'no anuncia dry-run'
printf '%s' "$DRY" | grep -Fq 'repair-invariant --actor=actor-1' || fail 'no invoca repair-invariant'
printf '%s' "$DRY" | grep -Fq -- '--apply' && fail 'el dry-run pasó --apply'

if DEPLOY_TARGET=otro-host run actor-1 >/dev/null 2>&1; then fail 'aceptó el host equivocado'; fi
if DEPLOY_TARGET=test-host EXPECTED_FINGERPRINT="$FP" run actor-1 --apply >/dev/null 2>&1; then
  fail 'aceptó --apply sin confirmación exacta'
fi
if DEPLOY_TARGET=test-host CONFIRM_REPAIR_APPLY=apply-inventory-invariant-repair run actor-1 --apply >/dev/null 2>&1; then
  fail 'aceptó --apply sin huella'
fi

APPLY="$(DEPLOY_TARGET=test-host CONFIRM_REPAIR_APPLY=apply-inventory-invariant-repair \
  EXPECTED_FINGERPRINT="$FP" run actor-1 --apply)"
printf '%s' "$APPLY" | grep -Fq -- "--apply --expect=$FP" || fail 'apply no pasa la huella'

printf 'OK: inventory invariant repair wrapper contract\n'

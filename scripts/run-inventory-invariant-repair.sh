#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEPLOY_TARGET="${DEPLOY_TARGET:-}"
CONFIRM_REPAIR_APPLY="${CONFIRM_REPAIR_APPLY:-}"
EXPECTED_FINGERPRINT="${EXPECTED_FINGERPRINT:-}"
REPAIR_SERVICE="${REPAIR_SERVICE:-repair-invariant}"

usage() {
  cat >&2 <<'USAGE'
Usage:
  DEPLOY_TARGET=<hostname> ./scripts/run-inventory-invariant-repair.sh <actor user id>
  DEPLOY_TARGET=<hostname> CONFIRM_REPAIR_APPLY=apply-inventory-invariant-repair \
    EXPECTED_FINGERPRINT=<huella del dry-run> \
    ./scripts/run-inventory-invariant-repair.sh <actor user id> --apply

Dry-run is the default.
USAGE
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
ACTOR="$1"
MODE="${2:-}"
[[ -n "$ACTOR" ]] || usage
[[ -z "$MODE" || "$MODE" == "--apply" ]] || usage

if [[ -z "$DEPLOY_TARGET" ]]; then
  echo "ERROR: DEPLOY_TARGET es obligatorio." >&2
  exit 2
fi
ACTUAL_HOST="$(hostname)"
if [[ -z "$ACTUAL_HOST" || "$ACTUAL_HOST" != "$DEPLOY_TARGET" ]]; then
  echo "ERROR: este servidor es '$ACTUAL_HOST' y DEPLOY_TARGET='$DEPLOY_TARGET'." >&2
  echo "       No se ejecutó ninguna reparación." >&2
  exit 1
fi

ARGS=("--actor=$ACTOR")
if [[ "$MODE" == "--apply" ]]; then
  if [[ "$CONFIRM_REPAIR_APPLY" != "apply-inventory-invariant-repair" ]]; then
    echo "ERROR: --apply exige CONFIRM_REPAIR_APPLY=apply-inventory-invariant-repair." >&2
    exit 2
  fi
  if [[ ! "$EXPECTED_FINGERPRINT" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: --apply exige EXPECTED_FINGERPRINT con la huella del dry-run revisado." >&2
    exit 2
  fi
  ARGS+=(--apply "--expect=$EXPECTED_FINGERPRINT")
else
  echo "==> DRY-RUN: no se escribirán datos."
fi

cd "$APP_DIR"
exec docker compose run --rm --no-deps "$REPAIR_SERVICE" "${ARGS[@]}"

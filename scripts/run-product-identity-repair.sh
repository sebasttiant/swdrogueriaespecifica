#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEPLOY_TARGET="${DEPLOY_TARGET:-}"
CONFIRM_REPAIR_APPLY="${CONFIRM_REPAIR_APPLY:-}"
REPAIR_SERVICE="${REPAIR_SERVICE:-repair}"
CONTAINER_MANIFEST="/app/apps/web/repair.json"

usage() {
  cat >&2 <<'USAGE'
Usage:
  DEPLOY_TARGET=<hostname> ./scripts/run-product-identity-repair.sh <manifest.json>
  DEPLOY_TARGET=<hostname> CONFIRM_REPAIR_APPLY=apply-product-identity-repair \
    ./scripts/run-product-identity-repair.sh <manifest.json> --apply

Dry-run is the default. The script never invents or modifies a manifest.
USAGE
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
MANIFEST="$1"
MODE="${2:-}"
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

if [[ ! -f "$MANIFEST" ]]; then
  echo "ERROR: no existe el manifiesto '$MANIFEST'." >&2
  exit 2
fi
python3 -I -m json.tool "$MANIFEST" >/dev/null
MANIFEST="$(realpath "$MANIFEST")"

APPLY_ARGS=()
if [[ "$MODE" == "--apply" ]]; then
  if [[ "$CONFIRM_REPAIR_APPLY" != "apply-product-identity-repair" ]]; then
    echo "ERROR: --apply exige CONFIRM_REPAIR_APPLY=apply-product-identity-repair." >&2
    exit 2
  fi
  APPLY_ARGS=(--apply)
else
  echo "==> DRY-RUN: no se escribirán datos."
fi

cd "$APP_DIR"
exec docker compose run --rm --no-deps \
  -v "$MANIFEST:$CONTAINER_MANIFEST:ro" \
  "$REPAIR_SERVICE" \
  "--manifest=$CONTAINER_MANIFEST" \
  "${APPLY_ARGS[@]}"

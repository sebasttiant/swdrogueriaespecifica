#!/usr/bin/env bash
# ==========================================================================
# Bootstrap reproducible del toolchain — Droguería Específica
#
# Por qué existe: en entornos donde hay un pnpm global "standalone" más viejo
# que 11.10.0, ese pnpm intenta auto-provisionar 11.10.0 usando la config GLOBAL
# (p. ej. `minimumReleaseAge`), y puede quedar BLOQUEADO antes de aplicar el
# `.npmrc` del proyecto. La solución limpia es usar el pnpm de Corepack directo,
# priorizando su directorio en el PATH. NO toca ninguna config global.
#
# Uso:
#   ./scripts/bootstrap.sh            # activa pnpm 11.10.0 + pnpm install
#   ./scripts/bootstrap.sh --prod     # pasa flags extra a pnpm install
# ==========================================================================
set -euo pipefail

PNPM_VERSION="11.10.0"

if ! command -v corepack >/dev/null 2>&1; then
  echo "ERROR: corepack no está disponible. Viene con Node >= 16.9; instalá Node 24.18.0 (ver .nvmrc)." >&2
  exit 1
fi

# Corepack baja pnpm SIN pasar por la auto-provisión del pnpm global
# (por eso no lo afecta minimumReleaseAge global).
corepack enable
corepack prepare "pnpm@${PNPM_VERSION}" --activate

# El shim de pnpm de Corepack vive en el mismo dir que `corepack`.
# Priorizándolo en el PATH, gana sobre cualquier pnpm standalone global.
COREPACK_BIN="$(dirname "$(command -v corepack)")"
export PATH="${COREPACK_BIN}:${PATH}"

echo "pnpm -> $(command -v pnpm) ($(pnpm -v))"
if [ "$(pnpm -v)" != "${PNPM_VERSION}" ]; then
  echo "ERROR: se esperaba pnpm ${PNPM_VERSION} pero hay $(pnpm -v) en el PATH." >&2
  exit 1
fi

pnpm install "$@"
echo "Bootstrap OK. Tip: agregá esta línea a tu shell rc para que persista:"
echo "  export PATH=\"\$(dirname \"\$(command -v corepack)\"):\$PATH\""

#!/usr/bin/env bash
# ==========================================================================
# Seed de datos operativos demo — atajo de ejecución directa
#
# Wrapper sobre import-operational-excel-data.sh. Siembra la demo de verdad
# (--execute) con la confirmación fuerte ya provista, para no tener que
# tipearla a mano.
#
# El script base sigue siendo seguro (corre en DRY_RUN por defecto). Este
# atajo es la versión explícita de "sembrar en serio". Acepta los mismos
# flags extra del script base (por ejemplo --skip-backup).
#
# Uso:
#   scripts/seed-demo-operational.sh
#   scripts/seed-demo-operational.sh --skip-backup
# ==========================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

echo "SEMBRAR DEMO OPERATIVO" | "${SCRIPT_DIR}/import-operational-excel-data.sh" --execute "$@"

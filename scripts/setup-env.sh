#!/usr/bin/env bash
# ==========================================================================
# Generación del `.env` para una instalación nueva — Droguería Específica
#
# Por qué existe: `env.example` trae marcadores (`change_me_...`) que hay que
# reemplazar a mano, y este repositorio es PÚBLICO. Un `.env` que quede con el
# `AUTH_SECRET` de ejemplo permite que cualquiera firme una cookie de sesión
# válida de superadministrador sin conocer ninguna contraseña. Este script
# elimina ese riesgo generando los secretos al azar en la propia máquina.
#
# Uso:
#   ./scripts/setup-env.sh              # crea .env en la raíz del proyecto
#   ENV_FILE=/ruta/.env ./scripts/setup-env.sh
#
# NUNCA sobrescribe un `.env` existente: si ya hay uno, aborta.
# ==========================================================================
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

POSTGRES_USER="${POSTGRES_USER:-drogueria_user}"
POSTGRES_DB="${POSTGRES_DB:-drogueria}"

if [ -e "$ENV_FILE" ]; then
  echo "ERROR: ya existe $ENV_FILE." >&2
  echo "       Este script no sobrescribe secretos en uso: cambiarlos dejaría" >&2
  echo "       la base inaccesible y cerraría todas las sesiones abiertas." >&2
  echo "       Si querés regenerarlo, movelo a un lado primero." >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: hace falta openssl para generar los secretos." >&2
  exit 1
fi

# Secreto apto para URL: `openssl rand -base64` produce `+`, `/` y `=`, y esos
# caracteres rompen la contraseña dentro de DATABASE_URL (habría que escaparla).
# Con base64 filtrado a [A-Za-z0-9] el valor entra tal cual en la URL.
#
# Se cierra con `cut` y no con `head -c`: `head` cierra la tubería apenas junta
# lo que necesita, el proceso de arriba muere por SIGPIPE y, con `pipefail`, eso
# aborta el script entero sin imprimir nada.
random_url_safe() {
  local length="$1"
  openssl rand -base64 $((length * 3)) | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-"$length"
}

POSTGRES_PASSWORD="$(random_url_safe 32)"
SEED_ADMIN_PASSWORD="$(random_url_safe 24)"
# AUTH_SECRET no viaja en ninguna URL, así que puede usar el alfabeto completo.
AUTH_SECRET="$(openssl rand -base64 48)"

umask 077
cat > "$ENV_FILE" <<EOF
# Generado por scripts/setup-env.sh el $(date +%Y-%m-%d).
# Contiene secretos reales: NUNCA comitear este archivo.

# --- PostgreSQL ---
POSTGRES_USER=$POSTGRES_USER
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=$POSTGRES_DB

# El host es el nombre del servicio de compose, no localhost: los contenedores
# se hablan por la red interna.
DATABASE_URL=postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB?schema=public

# --- Entorno ---
NODE_ENV=production

# --- Diagnóstico del alta de pendientes: full | errors | off ---
PENDING_DIAGNOSTICS=errors

# --- Auth ---
# Llave de firma del JWT de sesión. Quien la conoce puede fabricar una sesión
# de cualquier usuario sin su contraseña.
AUTH_SECRET=$AUTH_SECRET

# --- Administrador inicial ---
# Solo se usa si el administrador todavía no existe. Una vez creado, el seed no
# vuelve a tocar su contraseña.
SEED_ADMIN_PASSWORD=$SEED_ADMIN_PASSWORD
EOF

chmod 600 "$ENV_FILE"

echo "==> Creado $ENV_FILE (permisos 600)"
echo
echo "    Guardá esta contraseña ahora, no vuelve a mostrarse:"
echo
echo "      usuario:    admin@ilasesorias.com"
echo "      contraseña: $SEED_ADMIN_PASSWORD"
echo
echo "    Cambiala desde la aplicación después del primer ingreso."
echo "    El resto de los secretos quedó en el archivo y no hace falta anotarlo."

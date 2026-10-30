#!/usr/bin/env bash
# Pruebas en memoria de las guardas de `deploy.sh`: nunca acceden a Docker, git,
# contenedores ni red. Cada guarda es una función pura que decide; el efecto
# (fetch, switch, build) queda fuera y no se ejecuta acá.
#
# Estas guardas solo se ejercitan durante un despliegue real, que es el peor
# momento para descubrir que una está mal. De ahí que se prueben aisladas.
set -Eeuo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

# Se extraen del script real, no se copian: una prueba contra una copia
# demuestra que la copia funciona.
extract() {
  sed -n "/^$1() {/,/^}/p" deploy.sh
}

for guard in assert_deploy_target branch_action; do
  body="$(extract "$guard")"
  [ -n "$body" ] || {
    printf 'ERROR: deploy.sh no define %s()\n' "$guard" >&2
    exit 1
  }
  eval "$body"
done

failures=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  ok   %s\n' "$label"
  else
    printf '  FAIL %s — esperado "%s", obtenido "%s"\n' "$label" "$expected" "$actual" >&2
    failures=$((failures + 1))
  fi
}

# Devuelve el código de salida de la guarda, silenciando su mensaje: lo que se
# prueba es la DECISIÓN, no la redacción.
target_status() {
  assert_deploy_target "$1" "$2" >/dev/null 2>&1 && printf 'ok' || printf 'abort'
}

printf '== assert_deploy_target ==\n'

# El caso que motivó la guarda: el 30 de octubre de 2026 un deploy destinado a
# pruebas entró en producción porque había dos sesiones SSH abiertas.
check 'destino declarado que NO es el host aborta' \
  abort "$(target_status vpsovhcloudsoprotelco vpsovhcloudilasesorias)"

check 'destino declarado que coincide continúa' \
  ok "$(target_status vpsovhcloudsoprotelco vpsovhcloudsoprotelco)"

# Sin destino declarado se conserva el comportamiento actual: la guarda es
# opcional, igual que EXPECTED_SHA. Exigirla rompería la operación existente.
check 'sin destino declarado continúa' \
  ok "$(target_status '' vpsovhcloudilasesorias)"

# Coincidencia EXACTA. Una guarda de seguridad que acepta coincidencias
# parciales es un agujero: `vps` coincidiría con cualquiera de los dos hosts.
check 'prefijo del host no alcanza' \
  abort "$(target_status soprotelco vpsovhcloudsoprotelco)"

check 'host que contiene al declarado no alcanza' \
  abort "$(target_status vpsovhcloud vpsovhcloudilasesorias)"

# El hostname real llega vacío cuando no se puede resolver. Con un destino
# declarado eso es "no se pudo verificar", y no verificar es justo lo que la
# guarda existe para evitar.
check 'host real vacío con destino declarado aborta' \
  abort "$(target_status vpsovhcloudsoprotelco '')"

printf '== branch_action ==\n'

check 'rama actual igual a la pedida: ok' \
  ok "$(branch_action main main 0)"

check 'rama distinta sin autorización: abort' \
  abort "$(branch_action docs/runbook main 0)"

# SWITCH_BRANCH=1 es autorización explícita del operador. La rama la sigue
# nombrando él mediante BRANCH; el script nunca la elige.
check 'rama distinta con autorización: switch' \
  switch "$(branch_action docs/runbook main 1)"

check 'rama igual con autorización sigue siendo ok, no switch' \
  ok "$(branch_action main main 1)"

# HEAD desacoplado deja la rama actual vacía. `git pull` integraría en nada,
# así que sin autorización se aborta igual que con cualquier otra rama.
check 'HEAD desacoplado sin autorización: abort' \
  abort "$(branch_action '' main 0)"

check 'HEAD desacoplado con autorización: switch' \
  switch "$(branch_action '' main 1)"

# Solo el 1 exacto autoriza. Un valor accidental —"0", "false", "no"— no puede
# mover el checkout de nadie.
for value in 0 false no '' yes 2; do
  check "SWITCH_BRANCH=\"$value\" no autoriza el switch" \
    abort "$(branch_action docs/runbook main "$value")"
done

if ((failures > 0)); then
  printf '\n%s prueba(s) fallaron.\n' "$failures" >&2
  exit 1
fi
printf '\nTodas las guardas de deploy.sh pasaron.\n'

import { describe, expect, it } from "vitest";

import { MISSING_QUEUE_PATH } from "./missing-scope";
import {
  STALE_PARAM,
  UNCLOSED_MISSING_ALERT_HOURS,
  resolveStaleOnly,
  staleMissingHref,
  staleThreshold,
} from "./missing-stale";

const AHORA = new Date("2026-09-07T15:00:00.000Z");

describe("resolveStaleOnly", () => {
  it("prende el filtro con el valor que escribe el aviso", () => {
    expect(resolveStaleOnly("8h")).toBe(true);
  });

  // El parámetro es input del usuario: cualquier otra cosa apaga el filtro en
  // vez de romper la página o abrir una vista que no existe.
  it.each([undefined, null, "", "si", "8", "24h", "TRUE"])(
    "lo apaga con %p",
    (valor) => {
      expect(resolveStaleOnly(valor)).toBe(false);
    },
  );
});

describe("staleThreshold", () => {
  it("mira exactamente las horas que el aviso anuncia", () => {
    const frontera = staleThreshold(AHORA);

    expect(AHORA.getTime() - frontera.getTime()).toBe(
      UNCLOSED_MISSING_ALERT_HOURS * 60 * 60 * 1000,
    );
  });
});

describe("staleMissingHref", () => {
  // El destino es la cola de REVISIÓN, no `/faltantes`: quien toca el aviso
  // viene a cerrar los que ya existen, no a cargar otro.
  it("abre la cola de revisión con el filtro puesto", () => {
    const href = staleMissingHref();

    expect(href.startsWith(MISSING_QUEUE_PATH)).toBe(true);
    expect(href).toContain(`${STALE_PARAM}=8h`);
  });

  // La pantalla tiene que ENTENDER lo que el aviso escribe. Con el enlace y el
  // resolvedor en archivos distintos, esto se rompe en silencio: el aviso sigue
  // enlazando y la lista deja de filtrar, que es el defecto original volviendo
  // por otra puerta.
  it("lo que escribe el enlace es lo que la pantalla lee", () => {
    const valor = new URL(staleMissingHref(), "https://x.local").searchParams.get(
      STALE_PARAM,
    );

    expect(resolveStaleOnly(valor)).toBe(true);
  });
});

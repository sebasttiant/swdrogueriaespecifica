/** @vitest-environment jsdom */

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { classTokens } from "@/lib/testing/class-tokens";

const mocks = vi.hoisted(() => ({
  countArrivalNotices: vi.fn(),
  getOperationalAlertsCached: vi.fn(),
}));

vi.mock("@/server/services/arrival-notice.service", () => ({
  countArrivalNotices: mocks.countArrivalNotices,
}));

vi.mock("@/server/services/operational-alerts.service", () => ({
  getOperationalAlertsCached: mocks.getOperationalAlertsCached,
}));

import type { AlertCounts } from "@/lib/alertas/signature";

import { AlertBar } from "./alert-bar";

// --------------------------------------------------------------------------
// JERARQUÍA Y COMPOSICIÓN de los chips DENTRO de la barra.
//
// Estas pruebas se miran EL CHIP, no el HTML entero, y esa es toda la
// diferencia. La versión anterior afirmaba `expect(html).toContain(
// "bg-danger-solid")` para probar el relleno del chip de peligro… y esa clase
// la pone el CONTENEDOR. El assert pasaba aunque el chip no tuviera una sola
// clase propia, que es exactamente el defecto que había: chip rojo pleno
// adentro de una barra roja plena, o sea invisible.
//
// Un test que se conforma con encontrar la clase en cualquier ancestro no
// prueba composición: prueba que la cadena existe en alguna parte.
// --------------------------------------------------------------------------

const SIN_ALERTAS: AlertCounts = {
  expiredBatches: 0,
  criticalBatches: 0,
  warningBatches: 0,
  overdueDeliveries: 0,
  upcomingDeliveries: 0,
  criticalMissing: 0,
  stockoutProducts: 0,
};

async function pintar(counts: Partial<AlertCounts>): Promise<HTMLElement> {
  mocks.getOperationalAlertsCached.mockResolvedValue({ ...SIN_ALERTAS, ...counts });
  const arbol = await AlertBar({ userId: "user-1", role: "ADMIN" });
  const host = document.createElement("div");
  host.innerHTML = arbol ? renderToStaticMarkup(arbol) : "";
  return host;
}

/** El contenedor del aviso operativo: el `role="alert"` o `role="status"`. */
function clasesDeLaBarra(host: HTMLElement): string[] {
  const barra = host.querySelector('[role="alert"], [role="status"]');
  return classTokens(barra?.getAttribute("class"));
}

/**
 * Las clases de UN chip, por su etiqueta. Devuelve una entrada por aparición
 * —el mismo chip se pinta dos veces, en el desplegable del celular y en la
 * fila de escritorio— y las pruebas afirman sobre TODAS: un arreglo que solo
 * llega a una de las dos vistas es medio arreglo.
 */
function clasesDelChip(host: HTMLElement, etiqueta: string): string[][] {
  return [...host.querySelectorAll("a")]
    .filter((enlace) => enlace.textContent?.startsWith(etiqueta))
    .map((enlace) => classTokens(enlace.getAttribute("class")));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.countArrivalNotices.mockResolvedValue(0);
});

describe("la barra de peligro es roja plena", () => {
  it("el contenedor lleva el relleno pleno", async () => {
    const host = await pintar({ expiredBatches: 3 });

    expect(clasesDeLaBarra(host)).toContain("bg-danger-solid");
  });

  it("el chip de peligro NO comparte el relleno del contenedor: lo invierte", async () => {
    const host = await pintar({ expiredBatches: 3 });
    const apariciones = clasesDelChip(host, "Vencidos");

    expect(apariciones.length).toBeGreaterThan(0);
    for (const clases of apariciones) {
      // Relleno blanco y letra roja: los dos tokens del par, al revés.
      expect(clases).toContain("bg-danger-solid-foreground");
      expect(clases).toContain("text-danger-solid");
      // Y JAMÁS el relleno del contenedor, que lo haría desaparecer.
      expect(clases).not.toContain("bg-danger-solid");
      expect(clases).not.toContain("border-danger-solid");
    }
  });

  it("el chip de advertencia queda de contorno sobre el rojo, sin tinte amarillo", async () => {
    const host = await pintar({ expiredBatches: 3, warningBatches: 7 });
    const apariciones = clasesDelChip(host, "Por vencer");

    expect(apariciones.length).toBeGreaterThan(0);
    for (const clases of apariciones) {
      expect(clases).toContain("text-danger-solid-foreground");
      expect(clases).toContain("border-danger-solid-foreground/60");
      // El tinte amarillo está pensado para la barra amarilla. Sobre el rojo
      // se ve como una mancha y pierde contraste.
      expect(clases).not.toContain("bg-warning/10");
      expect(clases).not.toContain("bg-danger-solid-foreground");
    }
  });

  it("ningún hover sobre el rojo toca el relleno, porque ahí se cae de AA", async () => {
    const host = await pintar({ expiredBatches: 3, warningBatches: 7 });
    const apariciones = [
      ...clasesDelChip(host, "Vencidos"),
      ...clasesDelChip(host, "Por vencer"),
    ];

    expect(apariciones.length).toBeGreaterThan(0);
    for (const clases of apariciones) {
      // Medido sobre `#dc2626`: blanco al 15 % da 4.05:1 y al 90 % da 4.14:1,
      // los dos bajo el 4.5:1 de AA. El hover se comunica con el contorno.
      expect(clases.filter((clase) => clase.startsWith("hover:bg-"))).toEqual([]);
    }
  });
});

describe("la barra de advertencia sigue tenue", () => {
  it("sin peligro, el contenedor y los chips conservan el tinte", async () => {
    const host = await pintar({ warningBatches: 7 });

    expect(clasesDeLaBarra(host)).toContain("bg-warning/10");
    expect(clasesDeLaBarra(host)).not.toContain("bg-danger-solid");

    const apariciones = clasesDelChip(host, "Por vencer");
    expect(apariciones.length).toBeGreaterThan(0);
    for (const clases of apariciones) {
      expect(clases).toContain("bg-warning/10");
      expect(clases).toContain("text-warning-foreground");
    }
  });
});

describe("el resumen del celular", () => {
  it("no usa el gris de superficies neutras, que sobre el rojo es ilegible", async () => {
    const host = await pintar({ expiredBatches: 3 });
    const resumen = host.querySelector("summary");

    expect(resumen).not.toBeNull();
    const controles = [...(resumen?.querySelectorAll("span") ?? [])].flatMap((span) =>
      classTokens(span.getAttribute("class")),
    );
    expect(controles).not.toContain("text-muted-foreground");
    expect(controles).toContain("opacity-80");
  });
});

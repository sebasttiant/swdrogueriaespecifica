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
// DÓNDE VIVE EL COLOR: en los chips, no en la barra.
//
// Estas pruebas se miran EL CHIP, no el HTML entero, y esa es toda la
// diferencia. Una versión anterior afirmaba `expect(html).toContain(
// "bg-danger-solid")` para probar el relleno del chip… y esa clase la ponía el
// CONTENEDOR. El assert pasaba aunque el chip no tuviera una sola clase propia.
// Un test que se conforma con encontrar la clase en cualquier ancestro no
// prueba composición: prueba que la cadena existe en alguna parte.
//
// Y la guarda más importante es la primera: LA BARRA NO PUEDE VOLVER A SER UN
// BLOQUE ROJO PLENO. Lo fue, y en el tablero quedaba apilada con el banner de
// gerencia —que sí es rojo pleno—, dos losas que se comían el tercio superior
// de la pantalla. El rojo pleno es de UN solo bloque de la app.
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

describe("la barra NO se tiñe: el color va en los chips", () => {
  it("el contenedor queda NEUTRO aunque haya peligro — nunca una segunda losa roja", async () => {
    const host = await pintar({ expiredBatches: 3 });
    const barra = clasesDeLaBarra(host);

    expect(barra).toContain("bg-muted");
    // La regresión que este test existe para impedir: en el tablero esta barra
    // convive con el banner de gerencia, que sí es rojo pleno.
    expect(barra).not.toContain("bg-danger-solid");
    expect(barra).not.toContain("bg-warning/10");
  });

  it("la urgencia sigue anunciándose, aunque el color no la muestre", async () => {
    const conPeligro = await pintar({ expiredBatches: 3 });
    const soloAviso = await pintar({ warningBatches: 7 });

    // El `role` NO cambió con el color: quien usa lector de pantalla necesita
    // que un peligro interrumpa y un aviso entre por la cola cortés.
    expect(conPeligro.querySelector('[role="alert"]')).not.toBeNull();
    expect(soloAviso.querySelector('[role="status"]')).not.toBeNull();
  });

  it("el chip de peligro lleva el relleno pleno", async () => {
    const host = await pintar({ expiredBatches: 3 });
    const apariciones = clasesDelChip(host, "Vencidos");

    expect(apariciones.length).toBeGreaterThan(0);
    for (const clases of apariciones) {
      expect(clases).toContain("bg-danger-solid");
      expect(clases).toContain("text-danger-solid-foreground");
    }
  });

  it("el chip de advertencia queda ámbar, para distinguirse del rojo a un metro", async () => {
    const host = await pintar({ expiredBatches: 3, warningBatches: 7 });
    const apariciones = clasesDelChip(host, "Por vencer");

    expect(apariciones.length).toBeGreaterThan(0);
    for (const clases of apariciones) {
      expect(clases).toContain("bg-warning/10");
      expect(clases).toContain("text-warning-foreground");
      expect(clases).not.toContain("bg-danger-solid");
    }
  });

  it("el hover del chip de peligro no toca el relleno, porque ahí se cae de AA", async () => {
    const host = await pintar({ expiredBatches: 3 });
    const apariciones = clasesDelChip(host, "Vencidos");

    expect(apariciones.length).toBeGreaterThan(0);
    for (const clases of apariciones) {
      // Medido sobre `#dc2626`: blanco al 15 % da 4.05:1 y al 90 % da 4.14:1,
      // los dos bajo el 4.5:1 de AA. El hover se comunica con el contorno.
      expect(clases.filter((clase) => clase.startsWith("hover:bg-"))).toEqual([]);
    }
  });
});

describe("el resumen del celular", () => {
  it("usa el gris de superficies neutras, que es lo que la barra volvió a ser", async () => {
    const host = await pintar({ expiredBatches: 3 });
    const resumen = host.querySelector("summary");

    expect(resumen).not.toBeNull();
    const controles = [...(resumen?.querySelectorAll("span") ?? [])].flatMap((span) =>
      classTokens(span.getAttribute("class")),
    );
    expect(controles).toContain("text-muted-foreground");
  });
});

/** @vitest-environment jsdom */

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
// A DÓNDE lleva cada chip.
//
// El defecto que motivó esto: "Vencidos 3" caía en `/productos`, una pantalla
// que empieza con el formulario de "Nuevo producto" y sigue con el catálogo
// entero sin filtrar. El chip decía cuántos había y después dejaba a la persona
// buscándolos a mano — o creando un producto, que es lo contrario de lo que
// venía a hacer.
//
// Un chip es una promesa: "hay N de esto, tocá para verlos". Si el destino no
// muestra esos N, la barra miente, y una barra que miente se ignora entera.
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

async function pintar(counts: Partial<AlertCounts>): Promise<string> {
  mocks.getOperationalAlertsCached.mockResolvedValue({ ...SIN_ALERTAS, ...counts });
  // ADMIN: el alcance global es el único que recibe las franjas de lote.
  const arbol = await AlertBar({ userId: "user-1", role: "ADMIN" });
  return arbol ? renderToStaticMarkup(arbol) : "";
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.countArrivalNotices.mockResolvedValue(0);
});

describe("destino de los chips de vencimiento", () => {
  it.each([
    ["expiredBatches", "expired"],
    ["criticalBatches", "critical"],
    ["warningBatches", "warning"],
  ] as const)("%s abre la franja %s de /vencimientos", async (field, tier) => {
    const html = await pintar({ [field]: 3 });

    expect(html).toContain(`/vencimientos?tier=${tier}`);
  });

  // La regresión concreta: el catálogo NO es el destino de un aviso de lotes.
  it("ningún chip de lote vuelve a caer en /productos", async () => {
    const html = await pintar({
      expiredBatches: 3,
      criticalBatches: 1,
      warningBatches: 7,
    });

    expect(html).not.toContain('href="/productos"');
  });
});

describe("el aviso con tres meses de antelación", () => {
  // `countExpiringBatches` calculaba esta franja desde siempre y la barra la
  // descartaba: el campo no existía en `AlertCounts`. Sin ella, la primera
  // noticia de un vencimiento llegaba a 30 días.
  it("se muestra cuando hay lotes en la ventana de 90 días", async () => {
    const html = await pintar({ warningBatches: 7 });

    expect(html).toContain("Por vencer (90 d)");
    expect(html).toContain("/vencimientos?tier=warning");
  });

  it("cuenta para el total de avisos, no solo se pinta", async () => {
    // El total sale en el resumen colapsable del celular.
    const html = await pintar({ warningBatches: 7 });

    expect(html).toContain("7 avisos");
  });

  it("no aparece cuando esa franja está vacía", async () => {
    const html = await pintar({ expiredBatches: 2 });

    expect(html).not.toContain("Por vencer (90 d)");
  });
});

// --------------------------------------------------------------------------
// Los otros tres chips: a la pantalla donde se RESUELVE, no a la de crear.
// --------------------------------------------------------------------------
describe("destino de los chips de entrega y faltantes", () => {
  it.each([
    ["overdueDeliveries", "/revision-pendientes?entrega=atrasadas"],
    ["upcomingDeliveries", "/revision-pendientes?entrega=proximas"],
    [
      "criticalMissing",
      "/revision-pendientes?tab=abastecimiento&amp;entrega=atrasadas",
    ],
  ] as const)("%s abre %s", async (field, href) => {
    const html = await pintar({ [field]: 4 });

    expect(html).toContain(href);
  });

  // La regresión: la barra mandaba a las dos pantallas de CAPTURA. `/pendientes`
  // arranca con el formulario de "Nuevo pendiente" y `/faltantes` con el de
  // reportar uno: el chip decía "4 atrasadas" y abría un formulario en blanco.
  it("ningún chip vuelve a caer en una pantalla de captura", async () => {
    const html = await pintar({
      overdueDeliveries: 4,
      upcomingDeliveries: 2,
      criticalMissing: 18,
    });

    expect(html).not.toContain('href="/pendientes"');
    expect(html).not.toContain('href="/faltantes"');
  });

  // /revision-faltantes filtra `origin: "shelf"` y este contador cuenta
  // `originId: { not: null }`. Enlazar ahí daría una lista vacía garantizada.
  it("los faltantes de clientes NO van a la cola de estantería", async () => {
    const html = await pintar({ criticalMissing: 18 });

    expect(html).not.toContain("/revision-faltantes");
  });
});

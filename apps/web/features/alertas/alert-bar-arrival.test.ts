/** @vitest-environment jsdom */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
// El aviso de llegada vive en la barra, pero NO es el aviso operativo.
//
// Tres decisiones que estas pruebas fijan para que nadie las deshaga sin
// darse cuenta:
//
// 1. Tono propio. Meter una buena noticia en la misma barra amarilla que
//    "faltantes sin resolver hace 8 horas" enseña a ignorar la barra entera.
// 2. No se pospone. Silenciar "tu mercadería llegó" es perder la venta. El
//    aviso se limpia con la ACCIÓN: al entregar, el pendiente sale del filtro.
// 3. Sin detalle. La barra se pinta en TODAS las pantallas; su trabajo es
//    sacarte de donde estás. El cliente y las cantidades están en /pendientes.
//    Repetir la tarjeta entera acá desborda en el celular.
// --------------------------------------------------------------------------

const SIN_ALERTAS: AlertCounts = {
  expiredBatches: 0,
  criticalBatches: 0,
  overdueDeliveries: 0,
  upcomingDeliveries: 0,
  criticalMissing: 0,
  stockoutProducts: 0,
};

async function pintar(): Promise<string> {
  const arbol = await AlertBar({ userId: "user-1", role: "OPERADOR" });
  return arbol ? renderToStaticMarkup(arbol) : "";
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOperationalAlertsCached.mockResolvedValue(SIN_ALERTAS);
  mocks.countArrivalNotices.mockResolvedValue(0);
});

afterEach(() => vi.clearAllMocks());

describe("aviso de llegada en la barra", () => {
  it("no aparece cuando no llegó nada", async () => {
    expect(await pintar()).toBe("");
  });

  it("aparece aunque no haya ninguna alerta operativa", async () => {
    mocks.countArrivalNotices.mockResolvedValue(2);

    expect(await pintar()).toContain("Llegaron 2 pedidos tuyos");
  });

  it("habla en singular cuando llegó uno solo", async () => {
    mocks.countArrivalNotices.mockResolvedValue(1);

    const html = await pintar();
    expect(html).toContain("Llegó 1 pedido tuyo");
    expect(html).not.toContain("pedidos tuyos");
  });

  it("lleva a los pendientes", async () => {
    mocks.countArrivalNotices.mockResolvedValue(1);

    expect(await pintar()).toContain('href="/pendientes"');
  });

  // El detalle vive en /pendientes. En la barra sería ruido, y en el celular
  // desborda: la barra se ve en todas las pantallas.
  it("NO repite el detalle del pendiente", async () => {
    mocks.countArrivalNotices.mockResolvedValue(1);

    const html = await pintar();
    expect(html).not.toContain("disponibles");
    expect(html).not.toContain("avisado");
  });

  // Si la consulta operativa se cae, la mercadería llegó igual.
  it("sobrevive a un fallo del aviso operativo", async () => {
    mocks.countArrivalNotices.mockResolvedValue(1);
    mocks.getOperationalAlertsCached.mockRejectedValue(new Error("db caída"));

    expect(await pintar()).toContain("Llegó 1 pedido tuyo");
  });

  // Al revés: un fallo contando llegadas no puede tumbar el aviso operativo.
  it("un fallo contando llegadas no tumba la barra", async () => {
    mocks.countArrivalNotices.mockRejectedValue(new Error("db caída"));
    mocks.getOperationalAlertsCached.mockResolvedValue({
      ...SIN_ALERTAS,
      overdueDeliveries: 3,
    });

    expect(await pintar()).toContain("Atrasadas");
  });
});

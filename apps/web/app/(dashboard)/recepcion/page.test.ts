import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  listReceiverQueue: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireCapability: mocks.requireCapability,
}));
// `resolveReceiverScope` se deja REAL: es la regla que sanea la URL, y
// doblarla haría que estos tests prueben el doble en vez del saneo.
vi.mock("@/server/services/missing-receiver.service", async (original) => {
  const actual = await original<
    typeof import("@/server/services/missing-receiver.service")
  >();
  return { ...actual, listReceiverQueue: mocks.listReceiverQueue };
});

import RecepcionPage from "./page";

function searchParams(params: { scope?: string } = {}) {
  return Promise.resolve(params);
}

function fila(overrides: Partial<{ id: string; originId: string | null }> = {}) {
  return {
    id: "mi-1",
    originId: null,
    productId: "prod-1",
    productName: "Glucerna",
    orionCode: "1020",
    unit: "unidad",
    laboratoryName: "MK",
    requestedLaboratoryName: null,
    orderedQuantity: 12,
    receivedQuantity: 0,
    outstandingQuantity: 12,
    status: "PEDIDO" as const,
    orderedAt: new Date("2026-08-29T10:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCapability.mockResolvedValue({ user: { id: "u-1", role: "BODEGA" } });
  mocks.listReceiverQueue.mockResolvedValue([]);
});

describe("RecepcionPage · autorización", () => {
  it("guarda con canReceiveMissingItems", async () => {
    await RecepcionPage({ searchParams: searchParams() });

    expect(mocks.requireCapability).toHaveBeenCalledWith("canReceiveMissingItems");
  });

  // Con el guard después de la consulta, un rol sin permiso tendría la cola en
  // memoria durante todo lo que tarde la query.
  it("corre el guard ANTES de consultar la cola", async () => {
    const orden: string[] = [];
    mocks.requireCapability.mockImplementation(async () => {
      orden.push("guard");
      return { user: { id: "u-1", role: "BODEGA" } };
    });
    mocks.listReceiverQueue.mockImplementation(async () => {
      orden.push("query");
      return [];
    });

    await RecepcionPage({ searchParams: searchParams() });

    expect(orden).toEqual(["guard", "query"]);
  });
});

describe("RecepcionPage · las dos pestañas de bodega", () => {
  it("abre en 'Por recibir'", async () => {
    await RecepcionPage({ searchParams: searchParams() });

    expect(mocks.listReceiverQueue).toHaveBeenCalledWith("PEDIDO");
  });

  it("puede abrir 'En bodega'", async () => {
    await RecepcionPage({ searchParams: searchParams({ scope: "arrived" }) });

    expect(mocks.listReceiverQueue).toHaveBeenCalledWith("EN_BODEGA");
  });

  // Esconder pestañas no alcanza: quien escribe la URL a mano tiene que caer en
  // una cola permitida, y la consulta jamás debe pedir los estados de compras.
  // Bodega no decide qué se compra; ver esa cola invita a marcar llegadas sobre
  // mercadería que nadie pidió.
  it.each(["pending", "discarded", "actionable", "inventado", "../../etc/passwd"])(
    "un scope de compras escrito a mano (%s) cae en 'Por recibir'",
    async (scope) => {
      await RecepcionPage({ searchParams: searchParams({ scope }) });

      expect(mocks.listReceiverQueue).toHaveBeenCalledWith("PEDIDO");
    },
  );
});

// --------------------------------------------------------------------------
// UNA sola cola con los dos orígenes. Bodega recibe cajas y no clasifica de
// dónde nació la demanda: partírsela en dos pantallas es cómo se pierde una
// llegada.
// --------------------------------------------------------------------------
describe("RecepcionPage · una cola, los dos orígenes", () => {
  it("no filtra por origen: pide la cola entera por estado", async () => {
    await RecepcionPage({ searchParams: searchParams() });

    // Un solo argumento —el estado—. Si algún día aparece un eje de origen acá,
    // la mercadería de un pendiente llegaría al depósito sin pantalla que la
    // muestre: el cliente ya pagó el abono y nadie se entera.
    expect(mocks.listReceiverQueue).toHaveBeenCalledWith("PEDIDO");
    expect(mocks.listReceiverQueue.mock.calls[0]).toHaveLength(1);
  });

  it("etiqueta cada fila con para qué es la caja", async () => {
    mocks.listReceiverQueue.mockResolvedValue([
      fila({ id: "mi-cliente", originId: "pending-1" }),
      fila({ id: "mi-estante", originId: null }),
    ]);

    const html = renderToStaticMarkup(await RecepcionPage({ searchParams: searchParams() }));

    expect(html).toContain("Cliente");
    expect(html).toContain("Estantería");
  });

  // La minimización vive en el `select` del servicio: la identidad del cliente
  // no llega hasta acá. Bodega necesita saber que hay alguien esperando para
  // priorizar la descarga, nunca quién es.
  it("muestra la CATEGORÍA del origen, jamás el cliente", async () => {
    mocks.listReceiverQueue.mockResolvedValue([
      fila({ id: "mi-cliente", originId: "pending-1" }),
    ]);

    const html = renderToStaticMarkup(await RecepcionPage({ searchParams: searchParams() }));

    expect(html).toContain("Cliente");
    // El id del pendiente tampoco se pinta: no le sirve a nadie y es un puntero
    // a datos que esta pantalla no debe tocar.
    expect(html).not.toContain("pending-1");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { missingItem: { count: vi.fn(), findMany: vi.fn() } },
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import {
  clientOrderMissingWhere,
  countOverdueMissingItems,
} from "@/server/repositories/missing-item.repository";
import {
  alertablePendingWhere,
  openPendingWhere,
} from "@/server/repositories/pending.repository";

import { countPendingReception, listPendingReception } from "./pending-reception.service";

const NOW = new Date("2026-09-06T17:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.missingItem.count.mockResolvedValue(0);
  prismaMock.missingItem.findMany.mockResolvedValue([]);
});

// --------------------------------------------------------------------------
// El chip "Pedidos sin conseguir" abre Abastecimiento, y tiene que encontrar
// ahí exactamente los que contó.
//
// Ese contador filtra `originId: { not: null }` — faltantes nacidos de un
// PEDIDO DE CLIENTE. Por eso el chip NO puede ir a /revision-faltantes, que
// filtra `origin: "shelf"`: conjuntos disjuntos, lista vacía garantizada.
// --------------------------------------------------------------------------
describe("clientOrderMissingWhere", () => {
  it("es la MISMA condición que cuenta el chip", async () => {
    await countOverdueMissingItems(NOW);

    expect(prismaMock.missingItem.count.mock.calls[0]![0].where).toEqual(
      clientOrderMissingWhere({ overdueOnly: true, now: NOW }),
    );
  });

  it("siempre exige haber nacido de un pendiente", () => {
    for (const overdueOnly of [true, false]) {
      expect(clientOrderMissingWhere({ overdueOnly, now: NOW }).originId).toEqual({
        not: null,
      });
    }
  });

  // Sin la ventana no hay filtro de fecha: la pestaña completa sigue mostrando
  // toda la cola, como siempre.
  it("sin la ventana no compara contra el reloj", () => {
    const origin = clientOrderMissingWhere({ now: NOW }).origin as Record<string, unknown>;

    expect(origin.promisedAt).toBeUndefined();
  });

  // ----------------------------------------------------------------------
  // EL ESTADO DEL PEDIDO ORIGEN TAMBIÉN FILTRA, con ventana y sin ventana.
  //
  // El riel puede seguir abierto cuando el pedido que lo originó ya murió:
  // `deliverPending` no lo toca, y AGOTADO no cancela nada. Sin esta condición
  // el chip contaba trabajo que ya no existe.
  // ----------------------------------------------------------------------
  // Los tres terminales quedan afuera de las dos formas. Cada rama lo dice a su
  // manera —la cola nombra lo que excluye, la alerta nombra lo que admite— y
  // por eso se afirma sobre la lista, no sobre el texto.
  const TERMINALES = ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"];

  it("la cola excluye exactamente los tres terminales", () => {
    const origin = clientOrderMissingWhere({ now: NOW }).origin as {
      status: { notIn: string[] };
    };

    expect(origin.status.notIn).toEqual(TERMINALES);
  });

  it("la alerta admite solo estados vivos", () => {
    const origin = clientOrderMissingWhere({ overdueOnly: true, now: NOW }).origin as {
      status: { in: string[] };
    };

    for (const terminal of TERMINALES) {
      expect(origin.status.in).not.toContain(terminal);
    }
  });

  // ----------------------------------------------------------------------
  // LA VENTANA NO ES SOLO UNA FECHA: es el modo alerta, y cambia qué admite.
  //
  // El agotado sale del chip rojo —gritar por algo dado por perdido entrena a
  // ignorar el rojo— pero NO de la cola de bodega: si la caja aparece igual,
  // quien la recibe tiene que poder verla. Ver `pending-reception-independence`.
  // ----------------------------------------------------------------------
  it("el chip usa la MISMA condición que las alertas de entrega", () => {
    const origin = clientOrderMissingWhere({ overdueOnly: true, now: NOW }).origin;

    expect(origin).toEqual({ ...alertablePendingWhere(), promisedAt: { lt: NOW } });
  });

  it("la cola de bodega NO mira el estado de compra", () => {
    const origin = clientOrderMissingWhere({ now: NOW }).origin;

    expect(origin).toEqual(openPendingWhere());
    expect((origin as Record<string, unknown>).purchaseStatus).toBeUndefined();
  });
});

describe("listPendingReception", () => {
  it("recorta a los vencidos con la condición del chip", async () => {
    await listPendingReception({ overdueOnly: true, now: NOW });

    expect(prismaMock.missingItem.findMany.mock.calls[0]![0].where).toEqual(
      clientOrderMissingWhere({ overdueOnly: true, now: NOW }),
    );
  });

  it("sin la ventana trae la cola entera, como antes", async () => {
    await listPendingReception();

    const where = prismaMock.missingItem.findMany.mock.calls[0]![0].where;
    expect(where.origin.promisedAt).toBeUndefined();
    expect(where.originId).toEqual({ not: null });
  });

  it("el contador de la pestaña usa la misma base, sin ventana", async () => {
    await countPendingReception();

    expect(prismaMock.missingItem.count.mock.calls[0]![0].where).toEqual(
      clientOrderMissingWhere(),
    );
  });
});

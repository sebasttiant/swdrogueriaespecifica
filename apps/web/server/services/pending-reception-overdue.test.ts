import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { missingItem: { count: vi.fn(), findMany: vi.fn() } },
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import {
  clientOrderMissingWhere,
  countOverdueMissingItems,
} from "@/server/repositories/missing-item.repository";

import { countPendingReception, listPendingReception } from "./pending-reception.service";

const NOW = new Date("2026-09-06T17:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.missingItem.count.mockResolvedValue(0);
  prismaMock.missingItem.findMany.mockResolvedValue([]);
});

// --------------------------------------------------------------------------
// El chip "Faltantes críticos" abre Abastecimiento, y tiene que encontrar ahí
// exactamente los que contó.
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
    expect(clientOrderMissingWhere({ now: NOW }).origin).toBeUndefined();
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
    expect(where.origin).toBeUndefined();
    expect(where.originId).toEqual({ not: null });
  });

  it("el contador de la pestaña usa la misma base, sin ventana", async () => {
    await countPendingReception();

    expect(prismaMock.missingItem.count.mock.calls[0]![0].where).toEqual(
      clientOrderMissingWhere(),
    );
  });
});

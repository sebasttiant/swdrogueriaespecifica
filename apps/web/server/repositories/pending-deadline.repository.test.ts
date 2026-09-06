import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { pending: { count: vi.fn(), findMany: vi.fn() } },
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import {
  countOverduePendings,
  countUpcomingPendings,
  deadlineWhere,
  listPendings,
} from "./pending.repository";

const NOW = new Date("2026-09-06T17:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.pending.count.mockResolvedValue(0);
  prismaMock.pending.findMany.mockResolvedValue([]);
});

// --------------------------------------------------------------------------
// EL CONTRATO: el chip y la lista preguntan lo mismo.
//
// El chip "Atrasadas 4" enlaza a la lista filtrada por esa misma ventana. Si
// las dos condiciones se escriben por separado, divergen al primer cambio y el
// chip pasa a decir un número que la pantalla no muestra.
// --------------------------------------------------------------------------
describe("deadlineWhere", () => {
  it("es la MISMA condición que cuenta countOverduePendings", async () => {
    await countOverduePendings(NOW);
    expect(prismaMock.pending.count.mock.calls[0]![0].where).toEqual(
      deadlineWhere("atrasadas", NOW),
    );
  });

  it("es la MISMA condición que cuenta countUpcomingPendings", async () => {
    await countUpcomingPendings(NOW);
    expect(prismaMock.pending.count.mock.calls[0]![0].where).toEqual(
      deadlineWhere("proximas", NOW),
    );
  });

  it("respeta el recorte por dueño, igual que el contador", async () => {
    await countOverduePendings(NOW, "seller-1");
    expect(prismaMock.pending.count.mock.calls[0]![0].where).toEqual(
      deadlineWhere("atrasadas", NOW, "seller-1"),
    );
  });

  // Disjuntas por construcción: atrasada usa `lt: now`, próxima `gte: now`.
  // Un pendiente no puede estar en las dos, así que los chips no se pisan.
  it("las dos ventanas no se superponen", () => {
    const atrasadas = deadlineWhere("atrasadas", NOW).promisedAt as { lt: Date };
    const proximas = deadlineWhere("proximas", NOW).promisedAt as { gte: Date };

    expect(atrasadas.lt.getTime()).toBe(proximas.gte.getTime());
  });

  it("próximas cubre exactamente 24 h", () => {
    const w = deadlineWhere("proximas", NOW).promisedAt as { gte: Date; lte: Date };
    expect(w.lte.getTime() - w.gte.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("listPendings con eje de entrega", () => {
  // Va dentro de AND y no derramado: `deadlineWhere` trae su propio `status`, y
  // derramarlo pisaría en silencio el del scope.
  it("no pisa el status del scope", async () => {
    await listPendings({ axes: { deadline: "atrasadas" }, now: NOW });

    const where = prismaMock.pending.findMany.mock.calls[0]![0].where;
    expect(where.status).toBeDefined();
    expect(where.AND).toEqual([deadlineWhere("atrasadas", NOW)]);
  });

  it("sin el eje, la vista queda exactamente como estaba", async () => {
    await listPendings({ now: NOW });

    expect(prismaMock.pending.findMany.mock.calls[0]![0].where.AND).toBeUndefined();
  });
});

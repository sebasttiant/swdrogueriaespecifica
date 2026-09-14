import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    pending: {
      count: vi.fn(),
      findMany: vi.fn(),
      // Referencias a columnas (`prisma.pending.fields.*`): el eje de listos
      // para facturar compara dos columnas de la misma fila.
      fields: {
        quantity: { name: "quantity" },
        inventoryReadyQuantity: { name: "inventoryReadyQuantity" },
      },
    },
  },
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import {
  alertablePendingWhere,
  countOverduePendings,
  countReadyToInvoicePendings,
  countUpcomingPendings,
  deadlineWhere,
  listPendings,
  readyToInvoiceWhere,
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

  // ----------------------------------------------------------------------
  // EL AGOTADO VIVE EN DOS COLUMNAS, y filtrar solo por una no lo excluía.
  //
  // Hasta la migración 20260730230000 el estado de gestión se escribía en
  // `status`; desde entonces `updatePendingManagementStatus` escribe SOLO
  // `purchaseStatus`. La lista de estados alertables seguía mirando la columna
  // vieja, así que todo pendiente marcado agotado después de esa migración
  // seguía contando como atrasado. La exclusión estaba escrita y no tenía
  // efecto.
  // ----------------------------------------------------------------------
  it.each(["atrasadas", "proximas"] as const)(
    "%s excluye el agotado por las DOS columnas",
    (window) => {
      const where = deadlineWhere(window, NOW);

      expect(where.status).toEqual({
        in: ["PENDIENTE", "PARCIAL", "SOLICITADO", "BUSQUEDA", "COTIZANDO"],
      });
      expect(where.purchaseStatus).toEqual({ not: "AGOTADO" });
    },
  );

  it("la condición sale de la definición compartida, no de una copia", () => {
    const where = deadlineWhere("atrasadas", NOW);
    const shared = alertablePendingWhere();

    expect(where.status).toEqual(shared.status);
    expect(where.purchaseStatus).toEqual(shared.purchaseStatus);
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

// --------------------------------------------------------------------------
// U4 — listos para facturar. Es otro eje DERIVADO que va dentro de `AND`, y
// derramar un segundo `{ AND: [...] }` pisaría en silencio el de la entrega.
// --------------------------------------------------------------------------
describe("listPendings con listos para facturar", () => {
  it("combinado con la entrega conserva LAS DOS condiciones", async () => {
    await listPendings({ axes: { deadline: "atrasadas", invoice: "listos" }, now: NOW });

    const where = prismaMock.pending.findMany.mock.calls[0]![0].where;
    expect(where.AND).toEqual([deadlineWhere("atrasadas", NOW), readyToInvoiceWhere()]);
  });

  it("solo, va dentro de AND sin pisar el status del scope", async () => {
    await listPendings({ axes: { invoice: "listos" } });

    const where = prismaMock.pending.findMany.mock.calls[0]![0].where;
    expect(where.status).toEqual({ in: expect.any(Array) });
    expect(where.AND).toEqual([readyToInvoiceWhere()]);
  });

  it("la condición es la regla única: dos comparaciones de columna y los terminales afuera", () => {
    expect(readyToInvoiceWhere()).toEqual({
      AND: [
        { invoicedQuantity: { lt: { name: "quantity" } } },
        { invoicedQuantity: { lt: { name: "inventoryReadyQuantity" } } },
      ],
      status: { notIn: ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"] },
      customerStatus: { notIn: ["ENTREGADO", "CANCELADO"] },
    });
  });

  // El contador y la lista preguntan lo mismo: vista activa, mismo dueño, eje.
  it("el contador usa el MISMO where que la lista filtrada, con el recorte por dueño", async () => {
    await countReadyToInvoicePendings("seller-1");
    await listPendings({ ownerId: "seller-1", axes: { invoice: "listos" } });

    expect(prismaMock.pending.count.mock.calls[0]![0].where).toEqual(
      prismaMock.pending.findMany.mock.calls[0]![0].where,
    );
    expect(prismaMock.pending.count.mock.calls[0]![0].where.createdById).toBe("seller-1");
  });

  it("sin dueño cuenta la cola entera", async () => {
    await countReadyToInvoicePendings();

    expect(prismaMock.pending.count.mock.calls[0]![0].where).not.toHaveProperty("createdById");
  });
});

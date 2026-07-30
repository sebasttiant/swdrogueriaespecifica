import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    missingReport: {
      create: vi.fn(),
      groupBy: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateManyAndReturn: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import {
  createMissingReport,
  groupPendingReportsByName,
  linkMissingReports,
  resolveMissingReports,
  listPendingReportsForNames,
  reporterNamesByLinkedItemIds,
} from "./missing-report.repository";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.missingReport.create.mockImplementation(({ data }: { data: unknown }) => ({
    id: "report-1",
    ...(data as object),
  }));
  prismaMock.missingReport.groupBy.mockResolvedValue([]);
  prismaMock.missingReport.findMany.mockResolvedValue([]);
  prismaMock.missingReport.updateManyAndReturn.mockResolvedValue([]);
});

describe("createMissingReport", () => {
  it("persists rawName, normalizedName, sellerCode and reporterId", async () => {
    await createMissingReport({
      rawName: "Acetaminofén 500",
      normalizedName: "acetaminofén 500",
      sellerCode: "VEN-12",
      reporterId: "user-1",
    });

    expect(prismaMock.missingReport.create).toHaveBeenCalledWith({
      data: {
        rawName: "Acetaminofén 500",
        normalizedName: "acetaminofén 500",
        sellerCode: "VEN-12",
        reporterId: "user-1",
      },
    });
  });

  // El status por defecto (PENDING_REVIEW) lo pone el schema, no el repositorio.
  it("does not set status, letting the schema default apply", async () => {
    await createMissingReport({
      rawName: "Ibuprofeno",
      normalizedName: "ibuprofeno",
      reporterId: "user-1",
    });

    const arg = prismaMock.missingReport.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data).not.toHaveProperty("status");
  });

  // Dos reportes iguales son dos filas: no hay unique ni upsert que los una.
  it("creates an independent row per call, even for the same normalized name", async () => {
    await createMissingReport({ rawName: "A", normalizedName: "a", reporterId: "u1" });
    await createMissingReport({ rawName: "a", normalizedName: "a", reporterId: "u2" });

    expect(prismaMock.missingReport.create).toHaveBeenCalledTimes(2);
  });
});

describe("groupPendingReportsByName", () => {
  it("groups only PENDING_REVIEW reports by normalizedName, counted and newest-first", async () => {
    prismaMock.missingReport.groupBy.mockResolvedValue([
      { normalizedName: "acetaminofén", _count: { _all: 4 }, _max: { createdAt: new Date("2026-07-10") } },
    ]);

    await groupPendingReportsByName({ skip: 0, take: 21, status: "PENDING_REVIEW" });

    expect(prismaMock.missingReport.groupBy).toHaveBeenCalledWith({
      by: ["normalizedName"],
      where: { status: "PENDING_REVIEW" },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: "desc" } },
      skip: 0,
      take: 21,
    });
  });

  it("maps each group to normalizedName, count and latestReportedAt", async () => {
    const createdAt = new Date("2026-07-10T00:00:00.000Z");
    prismaMock.missingReport.groupBy.mockResolvedValue([
      { normalizedName: "acetaminofén", _count: { _all: 4 }, _max: { createdAt } },
    ]);

    const rows = await groupPendingReportsByName({ skip: 0, take: 21, status: "PENDING_REVIEW" });

    expect(rows).toEqual([
      { normalizedName: "acetaminofén", count: 4, latestReportedAt: createdAt },
    ]);
  });
});

describe("listPendingReportsForNames", () => {
  it("returns nothing without querying when the name list is empty", async () => {
    const rows = await listPendingReportsForNames([], "PENDING_REVIEW");

    expect(rows).toEqual([]);
    expect(prismaMock.missingReport.findMany).not.toHaveBeenCalled();
  });

  it("fetches PENDING_REVIEW reports for the given names, newest-first, with a minimal reporter select", async () => {
    prismaMock.missingReport.findMany.mockResolvedValue([]);

    await listPendingReportsForNames(["acetaminofén", "ibuprofeno"], "PENDING_REVIEW");

    expect(prismaMock.missingReport.findMany).toHaveBeenCalledWith({
      where: {
        status: "PENDING_REVIEW",
        normalizedName: { in: ["acetaminofén", "ibuprofeno"] },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        rawName: true,
        normalizedName: true,
        sellerCode: true,
        createdAt: true,
        reporter: { select: { id: true, name: true } },
      },
    });
  });

  it("does not select reporter email or any field beyond id and name", async () => {
    await listPendingReportsForNames(["x"], "PENDING_REVIEW");

    const select = prismaMock.missingReport.findMany.mock.calls[0]![0].select;
    expect(select.reporter).toEqual({ select: { id: true, name: true } });
    expect(select).not.toHaveProperty("reporterId");
  });
});

describe("linkMissingReports", () => {
  it("marks the whole group LINKED with the product and the generated faltante", async () => {
    prismaMock.missingReport.updateManyAndReturn.mockResolvedValue([{ id: "r1" }, { id: "r2" }]);

    await linkMissingReports({
      normalizedName: "tiamina",
      productId: "prod-1",
      missingItemId: "missing-1",
    });

    expect(prismaMock.missingReport.updateManyAndReturn).toHaveBeenCalledWith({
      where: { normalizedName: "tiamina", status: "PENDING_REVIEW" },
      data: {
        status: "LINKED",
        linkedProductId: "prod-1",
        linkedMissingItemId: "missing-1",
      }, select: { id: true },
    });
  });

  // El `where` es un compare-and-set: un reporte que otro gerente ya vinculó no
  // coincide, así que no se re-escribe ni se pisa su vínculo anterior.
  it("only writes over reports still pending review", async () => {
    await linkMissingReports({
      normalizedName: "tiamina",
      productId: "prod-1",
      missingItemId: "missing-1",
    });

    const where = prismaMock.missingReport.updateManyAndReturn.mock.calls[0]![0].where;
    expect(where.status).toBe("PENDING_REVIEW");
  });

  it("returns how many reports it actually linked", async () => {
    prismaMock.missingReport.updateManyAndReturn.mockResolvedValue([{ id: "r1" }, { id: "r2" }, { id: "r3" }]);

    const linked = await linkMissingReports({
      normalizedName: "tiamina",
      productId: "prod-1",
      missingItemId: "missing-1",
    });

    expect(linked).toEqual(["r1", "r2", "r3"]);
  });

  it("reports zero when the group was already linked by someone else", async () => {

    const linked = await linkMissingReports({
      normalizedName: "tiamina",
      productId: "prod-1",
      missingItemId: "missing-1",
    });

    expect(linked).toEqual([]);
  });
});

describe("reporterNamesByLinkedItemIds", () => {
  // Sin ids no hay nada que resolver: ni siquiera se consulta la base.
  it("returns an empty map without querying when there are no ids", async () => {
    const result = await reporterNamesByLinkedItemIds([]);

    expect(result.size).toBe(0);
    expect(prismaMock.missingReport.findMany).not.toHaveBeenCalled();
  });

  it("maps each linked missing item id to its reporter name", async () => {
    prismaMock.missingReport.findMany.mockResolvedValue([
      { linkedMissingItemId: "m-1", reporter: { name: "Juan Vendedor" } },
      { linkedMissingItemId: "m-2", reporter: { name: "Ana Vendedora" } },
    ]);

    const result = await reporterNamesByLinkedItemIds(["m-1", "m-2"]);

    expect(result.get("m-1")).toBe("Juan Vendedor");
    expect(result.get("m-2")).toBe("Ana Vendedora");
    const call = prismaMock.missingReport.findMany.mock.calls[0]![0];
    expect(call.where).toEqual({ linkedMissingItemId: { in: ["m-1", "m-2"] } });
  });

  // Determinismo: si dos reportes apuntaran al mismo faltante, gana el primero
  // (orden por createdAt asc + first-wins).
  it("keeps the first reporter when two reports point to the same item", async () => {
    prismaMock.missingReport.findMany.mockResolvedValue([
      { linkedMissingItemId: "m-1", reporter: { name: "Primero" } },
      { linkedMissingItemId: "m-1", reporter: { name: "Segundo" } },
    ]);

    const result = await reporterNamesByLinkedItemIds(["m-1"]);

    expect(result.get("m-1")).toBe("Primero");
  });
});

// --------------------------------------------------------------------------
// Salidas rápidas de la cola. Hasta ahora un reporte solo salía vinculándolo al
// catálogo; si el producto no estaba cargado, quedaba atrapado para siempre.
// --------------------------------------------------------------------------
describe("resolveMissingReports", () => {
  it("marca como pedido solo los reportes que siguen pendientes", async () => {
    prismaMock.missingReport.updateManyAndReturn.mockResolvedValue([{ id: "r-1" }, { id: "r-2" }]);

    const written = await resolveMissingReports({
      normalizedName: "tiamina",
      resolution: "ORDERED",
      resolvedById: "adm-1",
    });

    expect(written).toEqual(["r-1", "r-2"]);
    // El compare-and-set es lo que hace la operación segura ante dos gerentes
    // resolviendo el mismo grupo: el segundo no pisa la decisión del primero.
    expect(prismaMock.missingReport.updateManyAndReturn).toHaveBeenCalledWith({
      where: { normalizedName: "tiamina", status: "PENDING_REVIEW" },
      data: { status: "ORDERED", resolvedById: "adm-1", resolvedAt: expect.any(Date) },
      select: { id: true },
    });
  });

  it("descarta con su propio estado, nunca reusando el de pedido", async () => {
    prismaMock.missingReport.updateManyAndReturn.mockResolvedValue([{ id: "r-1" }]);

    await resolveMissingReports({
      normalizedName: "tiamina",
      resolution: "DISCARDED",
      resolvedById: "adm-1",
    });

    const args = prismaMock.missingReport.updateManyAndReturn.mock.calls[0]![0];
    expect(args.data.status).toBe("DISCARDED");
  });

  // Un reporte que otro gerente ya resolvió no coincide con el CAS: se informa
  // como cero escrituras en vez de pisar la decisión anterior.
  it("devuelve cero cuando ninguno seguía pendiente", async () => {

    const written = await resolveMissingReports({
      normalizedName: "tiamina",
      resolution: "ORDERED",
      resolvedById: "adm-1",
    });

    expect(written).toEqual([]);
  });

  // Vincular sigue siendo la otra salida y no se toca: quien quiera seguimiento
  // de stock del producto todavía puede hacerlo.
  it("no interfiere con el vínculo al catálogo", async () => {
    prismaMock.missingReport.updateManyAndReturn.mockResolvedValue([{ id: "r-1" }]);

    await linkMissingReports({
      normalizedName: "tiamina",
      productId: "p-1",
      missingItemId: "m-1",
    });

    const args = prismaMock.missingReport.updateManyAndReturn.mock.calls[0]![0];
    expect(args.data.status).toBe("LINKED");
  });
});

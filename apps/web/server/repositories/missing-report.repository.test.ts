import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    missingReport: {
      create: vi.fn(),
      groupBy: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import {
  createMissingReport,
  groupPendingReportsByName,
  linkMissingReports,
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
  prismaMock.missingReport.updateMany.mockResolvedValue({ count: 0 });
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

    await groupPendingReportsByName({ skip: 0, take: 21 });

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

    const rows = await groupPendingReportsByName({ skip: 0, take: 21 });

    expect(rows).toEqual([
      { normalizedName: "acetaminofén", count: 4, latestReportedAt: createdAt },
    ]);
  });
});

describe("listPendingReportsForNames", () => {
  it("returns nothing without querying when the name list is empty", async () => {
    const rows = await listPendingReportsForNames([]);

    expect(rows).toEqual([]);
    expect(prismaMock.missingReport.findMany).not.toHaveBeenCalled();
  });

  it("fetches PENDING_REVIEW reports for the given names, newest-first, with a minimal reporter select", async () => {
    prismaMock.missingReport.findMany.mockResolvedValue([]);

    await listPendingReportsForNames(["acetaminofén", "ibuprofeno"]);

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
    await listPendingReportsForNames(["x"]);

    const select = prismaMock.missingReport.findMany.mock.calls[0]![0].select;
    expect(select.reporter).toEqual({ select: { id: true, name: true } });
    expect(select).not.toHaveProperty("reporterId");
  });
});

describe("linkMissingReports", () => {
  it("marks the whole group LINKED with the product and the generated faltante", async () => {
    prismaMock.missingReport.updateMany.mockResolvedValue({ count: 2 });

    await linkMissingReports({
      reportIds: ["r1", "r2"],
      productId: "prod-1",
      missingItemId: "missing-1",
    });

    expect(prismaMock.missingReport.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["r1", "r2"] }, status: "PENDING_REVIEW" },
      data: {
        status: "LINKED",
        linkedProductId: "prod-1",
        linkedMissingItemId: "missing-1",
      },
    });
  });

  // El `where` es un compare-and-set: un reporte que otro gerente ya vinculó no
  // coincide, así que no se re-escribe ni se pisa su vínculo anterior.
  it("only writes over reports still pending review", async () => {
    await linkMissingReports({
      reportIds: ["r1"],
      productId: "prod-1",
      missingItemId: "missing-1",
    });

    const where = prismaMock.missingReport.updateMany.mock.calls[0]![0].where;
    expect(where.status).toBe("PENDING_REVIEW");
  });

  it("returns how many reports it actually linked", async () => {
    prismaMock.missingReport.updateMany.mockResolvedValue({ count: 3 });

    const linked = await linkMissingReports({
      reportIds: ["r1", "r2", "r3"],
      productId: "prod-1",
      missingItemId: "missing-1",
    });

    expect(linked).toBe(3);
  });

  it("reports zero when the group was already linked by someone else", async () => {
    prismaMock.missingReport.updateMany.mockResolvedValue({ count: 0 });

    const linked = await linkMissingReports({
      reportIds: ["r1"],
      productId: "prod-1",
      missingItemId: "missing-1",
    });

    expect(linked).toBe(0);
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

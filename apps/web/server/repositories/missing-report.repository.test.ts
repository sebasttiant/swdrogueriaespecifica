import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    missingReport: {
      create: vi.fn(),
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import {
  createMissingReport,
  groupPendingReportsByName,
  listPendingReportsForNames,
} from "./missing-report.repository";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.missingReport.create.mockImplementation(({ data }: { data: unknown }) => ({
    id: "report-1",
    ...(data as object),
  }));
  prismaMock.missingReport.groupBy.mockResolvedValue([]);
  prismaMock.missingReport.findMany.mockResolvedValue([]);
});

describe("createMissingReport", () => {
  it("persists rawName, normalizedName and reporterId", async () => {
    await createMissingReport({
      rawName: "Acetaminofén 500",
      normalizedName: "acetaminofén 500",
      reporterId: "user-1",
    });

    expect(prismaMock.missingReport.create).toHaveBeenCalledWith({
      data: {
        rawName: "Acetaminofén 500",
        normalizedName: "acetaminofén 500",
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

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mockeamos los repos: el foco es la lógica de negocio del reporte y de la
// alerta de gerencia (cerrados = total - abiertos, umbral diario, ventana 8h),
// no las consultas Prisma (que se testean en los repos).
const repos = vi.hoisted(() => ({
  countAllPendings: vi.fn(),
  countOpenPendings: vi.fn(),
  groupPendingsByStatusSince: vi.fn(),
  listPendingCreatedAtSince: vi.fn(),
  countAllMissingItems: vi.fn(),
  countOpenMissingItems: vi.fn(),
  countMissingItemsCreatedSince: vi.fn(),
  countUnclosedActionableMissingItemsBefore: vi.fn(),
  groupMissingItemsByStatusSince: vi.fn(),
  listMissingItemCreatedAtSince: vi.fn(),
}));

vi.mock("@/server/repositories/pending.repository", () => ({
  countAllPendings: repos.countAllPendings,
  countOpenPendings: repos.countOpenPendings,
  groupPendingsByStatusSince: repos.groupPendingsByStatusSince,
  listPendingCreatedAtSince: repos.listPendingCreatedAtSince,
}));
vi.mock("@/server/repositories/missing-item.repository", () => ({
  countAllMissingItems: repos.countAllMissingItems,
  countOpenMissingItems: repos.countOpenMissingItems,
  countMissingItemsCreatedSince: repos.countMissingItemsCreatedSince,
  countUnclosedActionableMissingItemsBefore:
    repos.countUnclosedActionableMissingItemsBefore,
  groupMissingItemsByStatusSince: repos.groupMissingItemsByStatusSince,
  listMissingItemCreatedAtSince: repos.listMissingItemCreatedAtSince,
}));

import {
  DAILY_MISSING_ALERT_THRESHOLD,
  UNCLOSED_MISSING_ALERT_HOURS,
  getManagementMissingAlert,
  getReportsAnalytics,
  getReportsSummary,
  parseReportsPeriod,
} from "./reports.service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getReportsSummary", () => {
  it("calcula cerrados como total - abiertos y expone los creados hoy", async () => {
    repos.countAllPendings.mockResolvedValue(20);
    repos.countOpenPendings.mockResolvedValue(8);
    repos.countAllMissingItems.mockResolvedValue(15);
    repos.countOpenMissingItems.mockResolvedValue(6);
    repos.countMissingItemsCreatedSince.mockResolvedValue(4);

    const result = await getReportsSummary(new Date("2026-07-07T18:00:00Z"));

    expect(result.pendings).toEqual({ total: 20, open: 8, closed: 12 });
    expect(result.missing).toEqual({
      total: 15,
      open: 6,
      closed: 9,
      createdToday: 4,
    });
  });

  it("nunca devuelve cerrados negativos", async () => {
    repos.countAllPendings.mockResolvedValue(0);
    repos.countOpenPendings.mockResolvedValue(0);
    repos.countAllMissingItems.mockResolvedValue(0);
    repos.countOpenMissingItems.mockResolvedValue(0);
    repos.countMissingItemsCreatedSince.mockResolvedValue(0);

    const result = await getReportsSummary(new Date("2026-07-07T18:00:00Z"));

    expect(result.pendings.closed).toBe(0);
    expect(result.missing.closed).toBe(0);
  });
});

describe("getManagementMissingAlert", () => {
  it("se activa cuando hay faltantes abiertos con más de 8h sin cerrar", async () => {
    repos.countMissingItemsCreatedSince.mockResolvedValue(3);
    repos.countUnclosedActionableMissingItemsBefore.mockResolvedValue(2);

    const alert = await getManagementMissingAlert(new Date("2026-07-07T18:00:00Z"));

    expect(alert.unclosedOverThreshold).toBe(2);
    expect(alert.exceedsDailyThreshold).toBe(false);
    expect(alert.active).toBe(true);
  });

  it("se activa cuando hoy se generaron más de 10 faltantes", async () => {
    repos.countMissingItemsCreatedSince.mockResolvedValue(
      DAILY_MISSING_ALERT_THRESHOLD + 1,
    );
    repos.countUnclosedActionableMissingItemsBefore.mockResolvedValue(0);

    const alert = await getManagementMissingAlert(new Date("2026-07-07T18:00:00Z"));

    expect(alert.exceedsDailyThreshold).toBe(true);
    expect(alert.active).toBe(true);
  });

  it("no se activa sin faltantes viejos y con 10 o menos en el día (límite exacto)", async () => {
    repos.countMissingItemsCreatedSince.mockResolvedValue(
      DAILY_MISSING_ALERT_THRESHOLD,
    );
    repos.countUnclosedActionableMissingItemsBefore.mockResolvedValue(0);

    const alert = await getManagementMissingAlert(new Date("2026-07-07T18:00:00Z"));

    expect(alert.exceedsDailyThreshold).toBe(false);
    expect(alert.active).toBe(false);
  });

  it("consulta la ventana de faltantes viejos exactamente 8h antes de now", async () => {
    repos.countMissingItemsCreatedSince.mockResolvedValue(0);
    repos.countUnclosedActionableMissingItemsBefore.mockResolvedValue(0);
    const now = new Date("2026-07-07T18:00:00Z");

    await getManagementMissingAlert(now);

    const threshold = repos.countUnclosedActionableMissingItemsBefore.mock.calls[0]![0] as Date;
    expect(now.getTime() - threshold.getTime()).toBe(
      UNCLOSED_MISSING_ALERT_HOURS * 60 * 60 * 1000,
    );
  });
});

describe("parseReportsPeriod", () => {
  it("acepta los períodos válidos", () => {
    expect(parseReportsPeriod("7d")).toBe("7d");
    expect(parseReportsPeriod("30d")).toBe("30d");
    expect(parseReportsPeriod("90d")).toBe("90d");
  });

  it("cae a 7d con valores inválidos o ausentes", () => {
    expect(parseReportsPeriod(undefined)).toBe("7d");
    expect(parseReportsPeriod("todo")).toBe("7d");
    expect(parseReportsPeriod("")).toBe("7d");
  });
});

describe("getReportsAnalytics", () => {
  const now = new Date("2026-07-07T12:00:00Z"); // Bogotá: 2026-07-07 07:00

  function stubSummaryRepos() {
    repos.countAllPendings.mockResolvedValue(20);
    repos.countOpenPendings.mockResolvedValue(5);
    repos.countAllMissingItems.mockResolvedValue(10);
    repos.countOpenMissingItems.mockResolvedValue(4);
    repos.countMissingItemsCreatedSince.mockResolvedValue(2);
  }

  it("calcula distribución por estado con porcentajes y período", async () => {
    stubSummaryRepos();
    repos.groupPendingsByStatusSince.mockResolvedValue([
      { status: "PENDIENTE", count: 3 },
      { status: "ENTREGADO", count: 1 },
    ]);
    repos.groupMissingItemsByStatusSince.mockResolvedValue([
      { status: "FALTANTE", count: 2 },
      { status: "RECIBIDO", count: 2 },
    ]);
    repos.listPendingCreatedAtSince.mockResolvedValue([]);
    repos.listMissingItemCreatedAtSince.mockResolvedValue([]);

    const result = await getReportsAnalytics("7d", now);

    expect(result.period).toBe("7d");
    expect(result.summary.pendings.closed).toBe(15);
    const pendiente = result.pendingsByStatus.find((s) => s.status === "PENDIENTE");
    expect(pendiente).toMatchObject({ count: 3, percent: 75 });
    const recibido = result.missingByStatus.find((s) => s.status === "RECIBIDO");
    expect(recibido).toMatchObject({ count: 2, percent: 50 });
  });

  it("agrupa la tendencia por día de Bogotá dentro del período", async () => {
    stubSummaryRepos();
    repos.groupPendingsByStatusSince.mockResolvedValue([]);
    repos.groupMissingItemsByStatusSince.mockResolvedValue([]);
    repos.listPendingCreatedAtSince.mockResolvedValue([
      new Date("2026-07-07T12:00:00Z"), // 07-07 Bogotá
      new Date("2026-07-07T15:00:00Z"), // 07-07 Bogotá
      new Date("2026-07-05T12:00:00Z"), // 07-05 Bogotá
    ]);
    repos.listMissingItemCreatedAtSince.mockResolvedValue([
      new Date("2026-07-07T12:00:00Z"), // 07-07 Bogotá
    ]);

    const result = await getReportsAnalytics("7d", now);

    // 7 días: del 07-01 al 07-07 inclusive.
    expect(result.trend).toHaveLength(7);
    const last = result.trend.at(-1)!;
    expect(last.key).toBe("2026-07-07");
    expect(last.pendings).toBe(2);
    expect(last.missing).toBe(1);
    const day05 = result.trend.find((p) => p.key === "2026-07-05")!;
    expect(day05.pendings).toBe(1);
    expect(day05.missing).toBe(0);
  });

  it("porcentajes en 0 cuando no hay datos en el período", async () => {
    stubSummaryRepos();
    repos.groupPendingsByStatusSince.mockResolvedValue([]);
    repos.groupMissingItemsByStatusSince.mockResolvedValue([]);
    repos.listPendingCreatedAtSince.mockResolvedValue([]);
    repos.listMissingItemCreatedAtSince.mockResolvedValue([]);

    const result = await getReportsAnalytics("30d", now);

    expect(result.pendingsByStatus).toEqual([]);
    expect(result.missingByStatus).toEqual([]);
    expect(result.trend).toHaveLength(30);
  });
});

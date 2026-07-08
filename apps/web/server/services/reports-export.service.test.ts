import { describe, expect, it } from "vitest";

import { buildReportsExportModel } from "./reports-export.service";
import type { ReportsAnalytics } from "./reports.service";

const analytics: ReportsAnalytics = {
  period: "7d",
  summary: {
    pendings: { total: 20, open: 5, closed: 15 },
    missing: { total: 10, open: 4, closed: 6, createdToday: 2 },
  },
  pendingsByStatus: [
    { status: "PENDIENTE", label: "Pendiente", count: 5, percent: 25 },
    { status: "ENTREGADO", label: "Entregado", count: 15, percent: 75 },
  ],
  missingByStatus: [
    { status: "FALTANTE", label: "Faltante", count: 4, percent: 40 },
    { status: "RECIBIDO", label: "Recibido", count: 6, percent: 60 },
  ],
  trend: [
    { key: "2026-07-06", label: "06/07", pendings: 1, missing: 0 },
    { key: "2026-07-07", label: "07/07", pendings: 2, missing: 1 },
  ],
};

describe("buildReportsExportModel", () => {
  it("calcula porcentajes de abiertos/cerrados y deja Total/Creados hoy sin %", () => {
    const model = buildReportsExportModel(
      analytics,
      new Date("2026-07-07T12:00:00Z"),
    );

    expect(model.periodLabel).toBe("7 días");

    expect(model.pendings).toEqual([
      { label: "Total", value: 20, percent: null },
      { label: "Abiertos", value: 5, percent: 25 },
      { label: "Cerrados", value: 15, percent: 75 },
    ]);

    expect(model.missing).toEqual([
      { label: "Total", value: 10, percent: null },
      { label: "Abiertos", value: 4, percent: 40 },
      { label: "Cerrados", value: 6, percent: 60 },
      { label: "Creados hoy", value: 2, percent: null },
    ]);
  });

  it("nunca divide por cero cuando no hay registros", () => {
    const empty: ReportsAnalytics = {
      ...analytics,
      summary: {
        pendings: { total: 0, open: 0, closed: 0 },
        missing: { total: 0, open: 0, closed: 0, createdToday: 0 },
      },
    };

    const model = buildReportsExportModel(empty, new Date());

    expect(model.pendings[1]).toMatchObject({ label: "Abiertos", percent: 0 });
    expect(model.missing[2]).toMatchObject({ label: "Cerrados", percent: 0 });
  });

  it("pasa la distribución y la tendencia tal cual para las hojas", () => {
    const model = buildReportsExportModel(analytics, new Date());
    expect(model.pendingsByStatus).toHaveLength(2);
    expect(model.missingByStatus[0]).toMatchObject({ label: "Faltante", percent: 40 });
    expect(model.trend).toHaveLength(2);
  });
});

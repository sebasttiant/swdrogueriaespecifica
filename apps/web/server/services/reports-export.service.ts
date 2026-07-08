// --------------------------------------------------------------------------
// Exportación de reportería a Excel (.xlsx). Se separa en dos capas:
//
//  - `buildReportsExportModel`: PURO. Transforma la analítica en filas listas
//    para volcar (con porcentajes calculados). Testeable sin tocar exceljs.
//  - `buildReportsWorkbookBuffer`: render con exceljs (import dinámico, así el
//    grafo estático del módulo queda liviano y el test no carga la librería).
//
// Se eligió .xlsx real (no CSV) para evitar el problema del separador `,`/`;`
// en Excel en español y para que abra prolijo tanto en Excel como en Numbers
// (los gerentes entran mayormente desde iPhone).
// --------------------------------------------------------------------------

import { formatBogotaDate } from "@/lib/datetime/bogota";
import {
  REPORT_PERIOD_LABEL,
  type ReportsAnalytics,
  type StatusSlice,
  type TrendPoint,
} from "./reports.service";

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

export type ReportsExportRow = {
  label: string;
  value: number;
  // null → métrica sin porcentaje (ej. Total, Creados hoy).
  percent: number | null;
};

export type ReportsExportModel = {
  periodLabel: string;
  generatedAtLabel: string;
  pendings: ReportsExportRow[];
  missing: ReportsExportRow[];
  pendingsByStatus: StatusSlice[];
  missingByStatus: StatusSlice[];
  trend: TrendPoint[];
};

export function buildReportsExportModel(
  analytics: ReportsAnalytics,
  generatedAt: Date,
): ReportsExportModel {
  const { summary } = analytics;
  const p = summary.pendings;
  const m = summary.missing;

  return {
    periodLabel: REPORT_PERIOD_LABEL[analytics.period],
    generatedAtLabel: formatBogotaDate(generatedAt, { style: "datetime" }),
    pendings: [
      { label: "Total", value: p.total, percent: null },
      { label: "Abiertos", value: p.open, percent: pct(p.open, p.total) },
      { label: "Cerrados", value: p.closed, percent: pct(p.closed, p.total) },
    ],
    missing: [
      { label: "Total", value: m.total, percent: null },
      { label: "Abiertos", value: m.open, percent: pct(m.open, m.total) },
      { label: "Cerrados", value: m.closed, percent: pct(m.closed, m.total) },
      { label: "Creados hoy", value: m.createdToday, percent: null },
    ],
    pendingsByStatus: analytics.pendingsByStatus,
    missingByStatus: analytics.missingByStatus,
    trend: analytics.trend,
  };
}

// Colores de marca para los encabezados (ARGB, sin '#').
const HEADER_FILL = "FF0B66C3"; // primary
const HEADER_FONT = "FFFFFFFF"; // blanco

export async function buildReportsWorkbookBuffer(
  analytics: ReportsAnalytics,
  generatedAt: Date = new Date(),
): Promise<Buffer> {
  const model = buildReportsExportModel(analytics, generatedAt);
  // Import dinámico: mantiene exceljs fuera del grafo estático (test liviano).
  const ExcelJS = (await import("exceljs")).default;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Droguería Específica";
  wb.created = generatedAt;

  // Encabezado de sección reutilizable (fila con fondo primary + texto blanco).
  function sectionHeader(
    ws: import("exceljs").Worksheet,
    titles: string[],
  ): void {
    const row = ws.addRow(titles);
    row.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: HEADER_FONT } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: HEADER_FILL },
      };
    });
  }

  // -------- Hoja: Resumen --------
  const resumen = wb.addWorksheet("Resumen");
  resumen.columns = [{ width: 22 }, { width: 14 }, { width: 12 }];

  const title = resumen.addRow(["Droguería Específica — Reporte"]);
  title.font = { bold: true, size: 16 };
  resumen.addRow([`Período: ${model.periodLabel}`]);
  resumen.addRow([`Generado: ${model.generatedAtLabel}`]);
  resumen.addRow([]);

  sectionHeader(resumen, ["Pendientes", "Cantidad", "%"]);
  for (const row of model.pendings) {
    resumen.addRow([row.label, row.value, row.percent === null ? "" : `${row.percent}%`]);
  }
  resumen.addRow([]);

  sectionHeader(resumen, ["Faltantes", "Cantidad", "%"]);
  for (const row of model.missing) {
    resumen.addRow([row.label, row.value, row.percent === null ? "" : `${row.percent}%`]);
  }

  // -------- Hoja: Distribución --------
  const dist = wb.addWorksheet("Distribución");
  dist.columns = [{ width: 22 }, { width: 14 }, { width: 12 }];

  sectionHeader(dist, ["Pendientes por estado", "Cantidad", "%"]);
  for (const slice of model.pendingsByStatus) {
    dist.addRow([slice.label, slice.count, `${slice.percent}%`]);
  }
  dist.addRow([]);

  sectionHeader(dist, ["Faltantes por estado", "Cantidad", "%"]);
  for (const slice of model.missingByStatus) {
    dist.addRow([slice.label, slice.count, `${slice.percent}%`]);
  }

  // -------- Hoja: Tendencia --------
  const trend = wb.addWorksheet("Tendencia");
  trend.columns = [{ width: 14 }, { width: 14 }, { width: 14 }];
  sectionHeader(trend, ["Fecha", "Pendientes", "Faltantes"]);
  for (const point of model.trend) {
    trend.addRow([point.label, point.pendings, point.missing]);
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// --------------------------------------------------------------------------
// Servicio de reportería (server-only). Resume el estado operativo (pendientes
// y faltantes) y calcula la alerta de gerencia sobre faltantes sin cerrar.
//
// Regla de negocio:
//  - "cerrados" = total − abiertos (complementario, nunca negativo).
//  - Faltante "abierto" = sin confirmar y en estado FALTANTE/PEDIDO (lo define
//    el repo). "Cerrarlo" es el OK gerencia (confirmedAt) o pasar a RECIBIDO/CANCELADO.
//  - Alerta de gerencia: > 10 faltantes generados hoy, o algún faltante abierto
//    con más de 8h sin cerrarse.
// --------------------------------------------------------------------------

import { bogotaDayKey, bogotaStartOfDay } from "@/lib/datetime/bogota";
import type {
  MissingItemStatus,
  PendingStatus,
} from "@/lib/generated/prisma/client";
import {
  countAllPendings,
  countOpenPendings,
  groupPendingsByStatusSince,
  listPendingCreatedAtSince,
} from "@/server/repositories/pending.repository";
import {
  countAllMissingItems,
  countMissingItemsCreatedSince,
  countOpenMissingItems,
  countUnclosedMissingItemsBefore,
  groupMissingItemsByStatusSince,
  listMissingItemCreatedAtSince,
} from "@/server/repositories/missing-item.repository";

// Se dispara la alerta si HOY se generaron MÁS de este número de faltantes.
export const DAILY_MISSING_ALERT_THRESHOLD = 10;
// Antigüedad (horas) desde la que un faltante abierto cuenta como "sin cerrar".
export const UNCLOSED_MISSING_ALERT_HOURS = 8;
const MS_PER_HOUR = 60 * 60 * 1000;

export type ReportsSummary = {
  pendings: { total: number; open: number; closed: number };
  missing: { total: number; open: number; closed: number; createdToday: number };
};

export async function getReportsSummary(
  now: Date = new Date(),
): Promise<ReportsSummary> {
  const startOfDay = bogotaStartOfDay(now);

  const [
    pendingTotal,
    pendingOpen,
    missingTotal,
    missingOpen,
    missingCreatedToday,
  ] = await Promise.all([
    countAllPendings(),
    countOpenPendings(),
    countAllMissingItems(),
    countOpenMissingItems(),
    countMissingItemsCreatedSince(startOfDay),
  ]);

  return {
    pendings: {
      total: pendingTotal,
      open: pendingOpen,
      closed: Math.max(pendingTotal - pendingOpen, 0),
    },
    missing: {
      total: missingTotal,
      open: missingOpen,
      closed: Math.max(missingTotal - missingOpen, 0),
      createdToday: missingCreatedToday,
    },
  };
}

export type ManagementMissingAlert = {
  createdToday: number;
  // Faltantes abiertos con más de UNCLOSED_MISSING_ALERT_HOURS sin cerrarse.
  unclosedOverThreshold: number;
  exceedsDailyThreshold: boolean;
  // true si cualquiera de las dos condiciones se cumple: hay algo que avisar.
  active: boolean;
};

export async function getManagementMissingAlert(
  now: Date = new Date(),
): Promise<ManagementMissingAlert> {
  const startOfDay = bogotaStartOfDay(now);
  const staleThreshold = new Date(
    now.getTime() - UNCLOSED_MISSING_ALERT_HOURS * MS_PER_HOUR,
  );

  const [createdToday, unclosedOverThreshold] = await Promise.all([
    countMissingItemsCreatedSince(startOfDay),
    countUnclosedMissingItemsBefore(staleThreshold),
  ]);

  const exceedsDailyThreshold = createdToday > DAILY_MISSING_ALERT_THRESHOLD;

  return {
    createdToday,
    unclosedOverThreshold,
    exceedsDailyThreshold,
    active: exceedsDailyThreshold || unclosedOverThreshold > 0,
  };
}

// --------------------------------------------------------------------------
// Analítica del reporte: distribución por estado (para gráfico de pastel/dona
// con porcentajes) y tendencia de creación por día (para barras), acotadas por
// un período seleccionable (7/30/90 días). El bucketing por día usa la hora de
// Bogotá para que "hoy" y los cortes de día coincidan con la operación real.
// --------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const REPORT_PERIODS = ["7d", "30d", "90d"] as const;
export type ReportsPeriod = (typeof REPORT_PERIODS)[number];
const PERIOD_DAYS: Record<ReportsPeriod, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export const REPORT_PERIOD_LABEL: Record<ReportsPeriod, string> = {
  "7d": "7 días",
  "30d": "30 días",
  "90d": "90 días",
};

// Normaliza el query param del período; cae a 7d ante valores inválidos.
export function parseReportsPeriod(value: string | undefined): ReportsPeriod {
  return REPORT_PERIODS.includes(value as ReportsPeriod)
    ? (value as ReportsPeriod)
    : "7d";
}

// Orden y etiquetas canónicas de estado (semántico, estable para la leyenda).
const PENDING_STATUS_ORDER: PendingStatus[] = [
  "PENDIENTE",
  "PARCIAL",
  "SOLICITADO",
  "BUSQUEDA",
  "COTIZANDO",
  "AGOTADO",
  "ENTREGADO",
  "CANCELADO",
];
const PENDING_STATUS_LABEL: Record<PendingStatus, string> = {
  PENDIENTE: "Pendiente",
  PARCIAL: "Parcial",
  SOLICITADO: "Solicitado",
  BUSQUEDA: "En búsqueda",
  COTIZANDO: "Cotizando",
  AGOTADO: "Agotado",
  ENTREGADO: "Entregado",
  CANCELADO: "Cancelado",
};
const MISSING_STATUS_ORDER: MissingItemStatus[] = [
  "FALTANTE",
  "PEDIDO",
  "RECIBIDO",
  "CANCELADO",
];
const MISSING_STATUS_LABEL: Record<MissingItemStatus, string> = {
  FALTANTE: "Faltante",
  PEDIDO: "Pedido",
  EN_BODEGA: "En bodega",
  RECIBIDO: "Recibido",
  CANCELADO: "Cancelado",
};

export type StatusSlice = {
  status: string;
  label: string;
  count: number;
  percent: number;
};

export type TrendPoint = {
  key: string; // YYYY-MM-DD (Bogotá), ordenable
  label: string; // dd/mm para el eje
  pendings: number;
  missing: number;
};

export type ReportsAnalytics = {
  period: ReportsPeriod;
  summary: ReportsSummary;
  pendingsByStatus: StatusSlice[];
  missingByStatus: StatusSlice[];
  trend: TrendPoint[];
};

// Convierte los conteos por estado en slices ordenados con su porcentaje sobre
// el total del período. Descarta estados sin registros (no ensucian la leyenda).
function toStatusSlices<S extends string>(
  order: S[],
  labels: Record<S, string>,
  counts: { status: S; count: number }[],
): StatusSlice[] {
  const byStatus = new Map(counts.map((c) => [c.status, c.count]));
  const total = counts.reduce((sum, c) => sum + c.count, 0);

  return order
    .map((status) => ({ status, count: byStatus.get(status) ?? 0 }))
    .filter((entry) => entry.count > 0)
    .map((entry) => ({
      status: entry.status,
      label: labels[entry.status],
      count: entry.count,
      percent: total > 0 ? Math.round((entry.count / total) * 100) : 0,
    }));
}

// Serie de días (Bogotá) del período, del más viejo al más nuevo, con los
// registros de creación bucketeados por día.
function buildTrend(
  now: Date,
  days: number,
  pendingDates: Date[],
  missingDates: Date[],
): TrendPoint[] {
  const startOfToday = bogotaStartOfDay(now);
  const points: TrendPoint[] = [];
  const index = new Map<string, TrendPoint>();

  for (let i = days - 1; i >= 0; i--) {
    const dayStart = new Date(startOfToday.getTime() - i * MS_PER_DAY);
    const key = bogotaDayKey(dayStart);
    const point: TrendPoint = {
      key,
      label: `${key.slice(8, 10)}/${key.slice(5, 7)}`,
      pendings: 0,
      missing: 0,
    };
    points.push(point);
    index.set(key, point);
  }

  for (const date of pendingDates) {
    const point = index.get(bogotaDayKey(date));
    if (point) point.pendings += 1;
  }
  for (const date of missingDates) {
    const point = index.get(bogotaDayKey(date));
    if (point) point.missing += 1;
  }

  return points;
}

export async function getReportsAnalytics(
  period: ReportsPeriod,
  now: Date = new Date(),
): Promise<ReportsAnalytics> {
  const days = PERIOD_DAYS[period];
  const startOfToday = bogotaStartOfDay(now);
  // Inicio del período: incluye hoy → (days - 1) días hacia atrás.
  const since = new Date(startOfToday.getTime() - (days - 1) * MS_PER_DAY);

  const [
    summary,
    pendingGroups,
    missingGroups,
    pendingDates,
    missingDates,
  ] = await Promise.all([
    getReportsSummary(now),
    groupPendingsByStatusSince(since),
    groupMissingItemsByStatusSince(since),
    listPendingCreatedAtSince(since),
    listMissingItemCreatedAtSince(since),
  ]);

  return {
    period,
    summary,
    pendingsByStatus: toStatusSlices(
      PENDING_STATUS_ORDER,
      PENDING_STATUS_LABEL,
      pendingGroups,
    ),
    missingByStatus: toStatusSlices(
      MISSING_STATUS_ORDER,
      MISSING_STATUS_LABEL,
      missingGroups,
    ),
    trend: buildTrend(now, days, pendingDates, missingDates),
  };
}

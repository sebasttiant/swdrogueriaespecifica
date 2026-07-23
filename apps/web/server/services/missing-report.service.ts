import { normalizeMissingReportName } from "@/features/faltantes/missing-report-name";
import { clampTake } from "@/lib/pagination";
import {
  createMissingReport,
  groupPendingReportsByName,
  listPendingReportsForNames,
  type PendingReportRow,
} from "@/server/repositories/missing-report.repository";

export type SubmitMissingReportInput = {
  // Nombre tal cual lo pegó el vendedor desde Orión. Se conserva para mostrar.
  rawName: string;
  // Siempre desde la sesión en la capa de acción; el service no lo deriva.
  reporterId: string;
};

// El nombre pasó la validación de Zod (presencia + longitud) pero al normalizar
// quedó vacío: p. ej. solo caracteres de control, que `trim` no elimina. Es un
// error de validación de dominio, no un fallo de infraestructura; la acción lo
// mapea a un mensaje para el vendedor y NO persiste nada.
export class MissingReportEmptyNameError extends Error {
  constructor() {
    super("Missing report name is empty after normalization");
    this.name = "MissingReportEmptyNameError";
  }
}

// Registra un reporte provisional: normaliza el nombre para poder agrupar
// reportes del mismo producto más adelante, conservando el nombre original.
// No crea Product ni MissingItem, no maneja cantidades ni proveedores: es solo
// la observación "esto falta", pendiente de revisión de gerencia.
export async function submitMissingReport(input: SubmitMissingReportInput) {
  const normalizedName = normalizeMissingReportName(input.rawName);
  if (normalizedName === "") throw new MissingReportEmptyNameError();

  return createMissingReport({
    rawName: input.rawName,
    normalizedName,
    reporterId: input.reporterId,
  });
}

// --------------------------------------------------------------------------
// Cola de revisión de gerencia (solo lectura).
//
// Agrupa los reportes pendientes por `normalizedName` para no repetir el mismo
// producto reportado por varios vendedores. El conteo cuenta REPORTES, nunca
// suma cantidades: un MissingReport no tiene cantidad. Cada reporte individual
// se conserva en el historial del grupo, con quién lo reportó y cuándo.
//
// `normalizedName` es interno (sirve para agrupar); lo que se muestra es
// `displayName`: el nombre original del reporte más reciente, tal como lo pegó
// el vendedor desde Orión.
// --------------------------------------------------------------------------

export type MissingReportQueueGroup = {
  normalizedName: string;
  displayName: string;
  count: number;
  latestReportedAt: Date | null;
  reports: PendingReportRow[];
};

export type MissingReportQueue = {
  groups: MissingReportQueueGroup[];
  hasMore: boolean;
  page: number;
};

export async function getMissingReportQueue(params: {
  page: number;
  pageSize: number;
}): Promise<MissingReportQueue> {
  const page = Math.max(1, Math.trunc(params.page));
  // `pageSize` llega del llamador (en la UI, de la URL): se acota con la misma
  // convención de paginación del proyecto. Sin esto, un `take <= 0` haría que
  // Prisma lea en orden inverso, y un valor enorme abriría una consulta sin cota.
  const pageSize = clampTake(params.pageSize);

  // Se pide un grupo de más para saber si hay página siguiente sin un count
  // extra. Paginación por offset: `groupBy` no admite cursor.
  const rows = await groupPendingReportsByName({
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
  });

  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

  // Una sola consulta para el historial de TODOS los grupos de la página: nunca
  // una consulta por grupo.
  const reports = await listPendingReportsForNames(
    pageRows.map((row) => row.normalizedName),
  );

  const byName = new Map<string, PendingReportRow[]>();
  for (const report of reports) {
    const bucket = byName.get(report.normalizedName);
    if (bucket) bucket.push(report);
    else byName.set(report.normalizedName, [report]);
  }

  const groups = pageRows.flatMap((row) => {
    // `listPendingReportsForNames` ya viene ordenado por fecha desc, así que el
    // primero del grupo es el reporte más reciente.
    const groupReports = byName.get(row.normalizedName) ?? [];
    const newest = groupReports[0];

    // Un grupo sin reportes visibles solo puede venir de una carrera entre las
    // dos lecturas (no hay transacción: es una cola de solo lectura). Se omite:
    // mostrarlo dejaría el nombre NORMALIZADO interno en pantalla como si fuera
    // el nombre del producto, y un conteo que ya no corresponde.
    if (!newest) return [];

    return [
      {
        normalizedName: row.normalizedName,
        displayName: newest.rawName,
        count: row.count,
        latestReportedAt: row.latestReportedAt,
        reports: groupReports,
      },
    ];
  });

  return { groups, hasMore, page };
}

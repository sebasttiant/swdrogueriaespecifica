// --------------------------------------------------------------------------
// Repositorio de reportes provisionales de faltante — ÚNICO lugar que toca
// Prisma para `MissingReport`. Un reporte es la observación de un vendedor de
// que un producto (por su nombre) quedó en cero; NO es un Product ni un
// MissingItem canónico. Cada llamada crea una fila independiente: reportes
// repetidos se conservan por separado (no hay unique ni upsert), y no hay
// cantidad que sumar.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";

export type CreateMissingReportData = {
  rawName: string;
  normalizedName: string;
  reporterId: string;
};

export function createMissingReport(data: CreateMissingReportData) {
  return prisma.missingReport.create({
    data: {
      rawName: data.rawName,
      normalizedName: data.normalizedName,
      reporterId: data.reporterId,
    },
  });
}

// --------------------------------------------------------------------------
// Cola de revisión de gerencia (solo lectura). Se agrupa por `normalizedName`
// para no repetir el mismo producto reportado por varios vendedores, PERO cada
// reporte individual se conserva: el conteo cuenta reportes, no suma cantidades
// (MissingReport no tiene cantidad). El índice `(status, normalizedName)`
// justifica ambas consultas de abajo.
// --------------------------------------------------------------------------

export type PendingReportGroupRow = {
  normalizedName: string;
  count: number;
  latestReportedAt: Date | null;
};

// Página de grupos de reportes pendientes, más reciente primero. Paginación por
// offset: `groupBy` de Prisma no admite cursor, y la cola es de bajo volumen y
// solo para gerencia.
export async function groupPendingReportsByName(params: {
  skip: number;
  take: number;
}): Promise<PendingReportGroupRow[]> {
  const rows = await prisma.missingReport.groupBy({
    by: ["normalizedName"],
    where: { status: "PENDING_REVIEW" },
    _count: { _all: true },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: "desc" } },
    skip: params.skip,
    take: params.take,
  });

  return rows.map((row) => ({
    normalizedName: row.normalizedName,
    count: row._count._all,
    latestReportedAt: row._max.createdAt,
  }));
}

export type PendingReportRow = {
  id: string;
  rawName: string;
  normalizedName: string;
  createdAt: Date;
  reporter: { id: string; name: string } | null;
};

// Reportes individuales (pendientes) de los nombres normalizados dados, para el
// historial de cada grupo. Select mínimo del reportante: id y nombre, nunca
// email ni otros datos.
export async function listPendingReportsForNames(
  normalizedNames: string[],
): Promise<PendingReportRow[]> {
  if (normalizedNames.length === 0) return [];

  return prisma.missingReport.findMany({
    where: {
      status: "PENDING_REVIEW",
      normalizedName: { in: normalizedNames },
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
}

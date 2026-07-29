// --------------------------------------------------------------------------
// Repositorio de reportes provisionales de faltante — ÚNICO lugar que toca
// Prisma para `MissingReport`. Un reporte es la observación de un vendedor de
// que un producto (por su nombre) quedó en cero; NO es un Product ni un
// MissingItem canónico. Cada llamada crea una fila independiente: reportes
// repetidos se conservan por separado (no hay unique ni upsert), y no hay
// cantidad que sumar.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@/lib/generated/prisma/client";

export type CreateMissingReportData = {
  rawName: string;
  normalizedName: string;
  sellerCode?: string;
  reporterId: string;
};

export function createMissingReport(data: CreateMissingReportData) {
  return prisma.missingReport.create({
    data: {
      rawName: data.rawName,
      normalizedName: data.normalizedName,
      sellerCode: data.sellerCode,
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
  sellerCode: string | null;
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
      sellerCode: true,
      createdAt: true,
      reporter: { select: { id: true, name: true } },
    },
  });
}

// --------------------------------------------------------------------------
// Vinculación de un grupo de reportes al producto que gerencia eligió.
//
// UNA sola escritura para todo el grupo, con compare-and-set sobre `status`: si
// otro gerente ya vinculó alguno de esos reportes, esa fila no coincide y no se
// pisa su vínculo anterior. Evita además el estado a medias que dejaría una
// actualización por reporte.
// --------------------------------------------------------------------------

export type LinkMissingReportsData = {
  reportIds: string[];
  productId: string;
  missingItemId: string;
};

/**
 * Devuelve cuántos reportes quedaron efectivamente vinculados.
 *
 * `client` permite correr dentro de la MISMA transacción que crea el faltante:
 * si el CAS no coincide, el rollback también descarta ese faltante.
 */
export async function linkMissingReports(
  data: LinkMissingReportsData,
  client: Prisma.TransactionClient = prisma,
): Promise<number> {
  const { count } = await client.missingReport.updateMany({
    where: { id: { in: data.reportIds }, status: "PENDING_REVIEW" },
    data: {
      status: "LINKED",
      linkedProductId: data.productId,
      linkedMissingItemId: data.missingItemId,
    },
  });
  return count;
}

// --------------------------------------------------------------------------
// Trazabilidad (Mejora 5): el vendedor que REPORTÓ cada faltante nacido de un
// reporte. Un faltante vinculado tiene `createdBy` = gerencia (quien revisó),
// así que el solicitante real vive acá, en el `reporter` del reporte cuyo
// `linkedMissingItemId` apunta al faltante. Consulta por lote (índice
// `linkedMissingItemId`) para no hacer N+1 sobre la página de faltantes.
// --------------------------------------------------------------------------

export async function reporterNamesByLinkedItemIds(
  itemIds: string[],
): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map();

  const rows = await prisma.missingReport.findMany({
    where: { linkedMissingItemId: { in: itemIds } },
    select: { linkedMissingItemId: true, reporter: { select: { name: true } } },
    // Determinismo si dos reportes apuntaran al mismo faltante: gana el primero
    // (el reporte original). `first-wins` abajo lo garantiza.
    orderBy: { createdAt: "asc" },
  });

  const names = new Map<string, string>();
  for (const row of rows) {
    if (row.linkedMissingItemId && !names.has(row.linkedMissingItemId)) {
      names.set(row.linkedMissingItemId, row.reporter.name);
    }
  }
  return names;
}

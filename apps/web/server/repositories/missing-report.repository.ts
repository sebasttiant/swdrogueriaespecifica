// --------------------------------------------------------------------------
// Repositorio de reportes provisionales de faltante — ÚNICO lugar que toca
// Prisma para `MissingReport`. Un reporte es la observación de un vendedor de
// que un producto (por su nombre) quedó en cero; NO es un Product ni un
// MissingItem canónico. Cada llamada crea una fila independiente: reportes
// repetidos se conservan por separado (no hay unique ni upsert), y no hay
// cantidad que sumar.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type {
  MissingReportStatus,
  Prisma,
} from "@/lib/generated/prisma/client";

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

// Un solo estado o varios: la vista "ya pedidos" muestra junto lo pedido y lo
// que ya llegó, porque para gerencia son el mismo tramo del ciclo.
function statusFilter(status: MissingReportStatus | MissingReportStatus[]) {
  return Array.isArray(status) ? { in: status } : status;
}

export type PendingReportGroupRow = {
  normalizedName: string;
  count: number;
  latestReportedAt: Date | null;
};

// Página de grupos de reportes, más reciente primero. Paginación por offset:
// `groupBy` de Prisma no admite cursor, y la cola es de bajo volumen y solo
// para gerencia.
//
// `status` se parametriza para que la misma consulta sirva a las tres vistas
// —por revisar, ya pedidos, descartados— sin duplicar el groupBy. Sin default:
// que el llamador olvide el estado debe ser un error de tipos, no una vista que
// mezcla silenciosamente lo pendiente con lo resuelto.
export async function groupPendingReportsByName(params: {
  skip: number;
  take: number;
  status: MissingReportStatus | MissingReportStatus[];
}): Promise<PendingReportGroupRow[]> {
  const rows = await prisma.missingReport.groupBy({
    by: ["normalizedName"],
    where: { status: statusFilter(params.status) },
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
  status: MissingReportStatus | MissingReportStatus[],
): Promise<PendingReportRow[]> {
  if (normalizedNames.length === 0) return [];

  return prisma.missingReport.findMany({
    where: {
      status: statusFilter(status),
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
  normalizedName: string;
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
): Promise<string[]> {
  const reports = await client.missingReport.updateManyAndReturn({
    where: { normalizedName: data.normalizedName, status: "PENDING_REVIEW" },
    data: {
      status: "LINKED",
      linkedProductId: data.productId,
      linkedMissingItemId: data.missingItemId,
    },
    select: { id: true },
  });
  return reports.map((report) => report.id);
}

// --------------------------------------------------------------------------
// Salida RÁPIDA de la cola de revisión, sin pasar por el catálogo.
//
// Regla de negocio (reunión 2026-07-30): gerencia lee el nombre que escribió el
// vendedor, ya sabe qué producto es y lo pide por teléfono. Obligarla a buscarlo
// en el catálogo para poder sacarlo de la cola era el cuello de botella: si el
// producto no estaba cargado, el reporte quedaba atrapado y la cola solo crecía.
//
// Vincular al catálogo sigue existiendo (`linkMissingReports`) para cuando se
// quiera seguimiento de stock. Esto es la otra salida, no su reemplazo.
// --------------------------------------------------------------------------

// Resoluciones rápidas. NO incluye LINKED: vincular escribe además el producto
// y el faltante generado, así que tiene su propia función.
//
// RECEIVED cierra el ciclo cuando la mercadería llegó. Existe porque estos
// reportes no se vinculan al catálogo —gerencia lo descartó por lento— y sin
// producto asociado el cierre automático por entrada de inventario no los
// alcanza: quedarían en ORDERED para siempre.
export type MissingReportResolution = "ORDERED" | "DISCARDED" | "RECEIVED";

export type ResolveMissingReportsData = {
  normalizedName: string;
  resolution: MissingReportResolution;
  // Estado que el llamador OBSERVÓ, y que el compare-and-set exige. Por defecto
  // `PENDING_REVIEW`, que es la cola de trabajo; "ya llegó" espera `ORDERED`,
  // así no puede marcarse recibido algo que nadie pidió.
  expectedStatus?: MissingReportStatus;
  resolvedById: string;
  resolvedAt?: Date;
};

/**
 * Devuelve cuántos reportes quedaron efectivamente resueltos.
 *
 * El compare-and-set sobre `PENDING_REVIEW` es lo que hace segura la operación
 * con dos gerentes trabajando la misma cola: el segundo no pisa la decisión del
 * primero, simplemente no escribe.
 */
export async function resolveMissingReports(
  data: ResolveMissingReportsData,
  client: Prisma.TransactionClient = prisma,
): Promise<string[]> {
  const reports = await client.missingReport.updateManyAndReturn({
    where: {
      normalizedName: data.normalizedName,
      status: data.expectedStatus ?? "PENDING_REVIEW",
    },
    data: {
      status: data.resolution,
      resolvedById: data.resolvedById,
      resolvedAt: data.resolvedAt ?? new Date(),
    },
    select: { id: true },
  });
  return reports.map((report) => report.id);
}

export async function markReportsOrdered(
  client: Prisma.TransactionClient,
  data: { normalizedName: string; productId: string; missingItemId: string; resolvedById: string; resolvedAt: Date },
): Promise<string[]> {
  const reports = await client.missingReport.updateManyAndReturn({
    where: { normalizedName: data.normalizedName, status: "PENDING_REVIEW" },
    data: {
      status: "ORDERED",
      linkedProductId: data.productId,
      linkedMissingItemId: data.missingItemId,
      resolvedById: data.resolvedById,
      resolvedAt: data.resolvedAt,
    },
    select: { id: true },
  });
  return reports.map((report) => report.id);
}

export async function findPendingGroupDisplayName(
  client: Prisma.TransactionClient,
  normalizedName: string,
): Promise<string | null> {
  const report = await client.missingReport.findFirst({
    where: { normalizedName, status: "PENDING_REVIEW" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { rawName: true },
  });
  return report?.rawName ?? null;
}

export async function getOrderedGroupMissingItemId(
  client: Prisma.TransactionClient,
  normalizedName: string,
): Promise<string | null> {
  const report = await client.missingReport.findFirst({
    where: { normalizedName, status: "ORDERED", linkedMissingItemId: { not: null } },
    select: { linkedMissingItemId: true },
  });
  return report?.linkedMissingItemId ?? null;
}

export async function markReportsArrived(
  client: Prisma.TransactionClient,
  data: { normalizedName: string; arrivedById: string; arrivedAt: Date },
): Promise<string[]> {
  const reports = await client.missingReport.updateManyAndReturn({
    where: { normalizedName: data.normalizedName, status: "ORDERED" },
    data: { status: "EN_BODEGA", arrivedById: data.arrivedById, arrivedAt: data.arrivedAt },
    select: { id: true },
  });
  return reports.map((report) => report.id);
}

export async function markReportsReceivedByMissingItemIds(
  client: Prisma.TransactionClient,
  missingItemIds: string[],
): Promise<number> {
  if (missingItemIds.length === 0) return 0;
  const { count } = await client.missingReport.updateMany({
    where: { linkedMissingItemId: { in: missingItemIds }, status: "EN_BODEGA" },
    data: { status: "RECEIVED" },
  });
  return count;
}

export type MyMissingReport = {
  id: string;
  rawName: string;
  status: MissingReportStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  arrivedAt: Date | null;
};

export function listMissingReportsForReporter(reporterId: string): Promise<MyMissingReport[]> {
  return prisma.missingReport.findMany({
    where: { reporterId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
    select: {
      id: true, rawName: true, status: true, createdAt: true, resolvedAt: true, arrivedAt: true,
    },
  });
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

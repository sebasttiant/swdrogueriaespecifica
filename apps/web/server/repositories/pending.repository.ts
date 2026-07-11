// --------------------------------------------------------------------------
// Repositorio de pendientes — ÚNICO lugar que toca Prisma para `Pending`.
// Listado SIEMPRE paginado (cursor-based). Trae el producto asociado para que
// la UI muestre nombre/código sin un query extra.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import {
  clampTake,
  decodeCursor,
  encodeCursor,
  type Paginated,
} from "@/lib/pagination";
import type { PendingStatus, Prisma } from "@/lib/generated/prisma/client";

export type PendingListItem = {
  id: string;
  quantity: number;
  status: PendingStatus;
  promisedAt: Date;
  customerName: string | null;
  note: string | null;
  createdAt: Date;
  deliveredQuantity: number;
  product: { id: string; name: string; code: string; unit: string };
};

export type CreatePendingData = {
  productId: string;
  quantity: number;
  promisedAt: Date;
  customerName?: string;
  note?: string;
  createdById?: string | null;
};

const LIST_SELECT = {
  id: true,
  quantity: true,
  status: true,
  promisedAt: true,
  customerName: true,
  note: true,
  createdAt: true,
  deliveredQuantity: true,
  product: { select: { id: true, name: true, code: true, unit: true } },
} as const;

// Mismo eje que `MissingItemScope`: "active" es la vista operativa (lo que
// todavía se trabaja) e "history" abre los estados cerrados. El default es
// "active" porque un ENTREGADO/CANCELADO ya no requiere atención y, mezclado en
// la vista por defecto, llena la primera página y empuja los abiertos detrás de
// la paginación.
export type PendingScope = "active" | "history";

export async function listPendings(params: {
  cursor?: string | null;
  take?: number;
  scope?: PendingScope;
}): Promise<Paginated<PendingListItem>> {
  const take = clampTake(params.take);
  let cursorId = params.cursor ? decodeCursor(params.cursor) : null;

  // El cursor es input controlado por el usuario. `decodeCursor` ya descarta la
  // basura (round-trip), pero un cursor bien formado puede apuntar a un id que
  // no existe (registro borrado o cursor inventado). Validamos su existencia con
  // un lookup barato por PK: si no existe, lo ignoramos y servimos la primera
  // página. Así un cursor inutilizable nunca rompe la consulta de paginación.
  if (cursorId) {
    const exists = await prisma.pending.findUnique({
      where: { id: cursorId },
      select: { id: true },
    });
    if (!exists) cursorId = null;
  }

  // take + 1 para detectar página siguiente sin un count extra.
  const rows = await prisma.pending.findMany({
    take: take + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    ...(params.scope === "history"
      ? {}
      : { where: { status: { in: OPEN_STATUSES } } }),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: LIST_SELECT,
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.id) : null;

  return { items, nextCursor };
}

// `client` permite ejecutar dentro de una transacción (Prisma.$transaction);
// por defecto usa el singleton. Así el service compone alta de pendiente +
// faltante de forma atómica sin que el repo conozca la transacción.
// Estados "abiertos": siguen requiriendo atención operativa.
const OPEN_STATUSES: PendingStatus[] = ["PENDIENTE", "PARCIAL"];

export function countOpenPendings(): Promise<number> {
  return prisma.pending.count({ where: { status: { in: OPEN_STATUSES } } });
}

// Total histórico de pendientes (para reportería: cerrados = total - abiertos).
export function countAllPendings(): Promise<number> {
  return prisma.pending.count();
}

// Reportería: distribución por estado de los pendientes creados desde `since`.
export async function groupPendingsByStatusSince(
  since: Date,
): Promise<{ status: PendingStatus; count: number }[]> {
  const rows = await prisma.pending.groupBy({
    by: ["status"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });
  return rows.map((row) => ({ status: row.status, count: row._count._all }));
}

// Reportería: fechas de creación de pendientes desde `since`, para agrupar la
// tendencia por día en el service (bucketing en hora de Bogotá).
export async function listPendingCreatedAtSince(since: Date): Promise<Date[]> {
  const rows = await prisma.pending.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true },
  });
  return rows.map((row) => row.createdAt);
}

// Vencidos = abiertos cuya promesa ya pasó.
export function countOverduePendings(now: Date = new Date()): Promise<number> {
  return prisma.pending.count({
    where: { status: { in: OPEN_STATUSES }, promisedAt: { lt: now } },
  });
}

// Próximas = abiertos cuya promesa es >= now y <= now + 24h.
// Spec R4/R5 boundary: exactly now + 24h counts as upcoming (lte, inclusive).
// Disjoint with countOverduePendings by construction (overdue uses lt: now).
const MS_24H = 24 * 60 * 60 * 1000;

export function countUpcomingPendings(now: Date = new Date()): Promise<number> {
  return prisma.pending.count({
    where: {
      status: { in: OPEN_STATUSES },
      promisedAt: { gte: now, lte: new Date(now.getTime() + MS_24H) },
    },
  });
}

// Pendientes abiertos más urgentes: los que vencen antes, primero.
export function listUrgentPendings(take: number): Promise<PendingListItem[]> {
  return prisma.pending.findMany({
    where: { status: { in: OPEN_STATUSES } },
    take,
    orderBy: [{ promisedAt: "asc" }, { id: "asc" }],
    select: LIST_SELECT,
  });
}

export async function createPending(
  data: CreatePendingData,
  client: Prisma.TransactionClient = prisma,
) {
  return client.pending.create({
    data: {
      productId: data.productId,
      quantity: data.quantity,
      promisedAt: data.promisedAt,
      customerName: data.customerName ?? null,
      note: data.note ?? null,
      createdById: data.createdById ?? null,
    },
  });
}

// --------------------------------------------------------------------------
// Ciclo de vida de entrega (Slice A): entregas parciales + cancelación.
// --------------------------------------------------------------------------

export type PendingForDelivery = {
  id: string;
  quantity: number;
  deliveredQuantity: number;
  status: PendingStatus;
};

/**
 * Bloquea (FOR UPDATE) la fila del pendiente y devuelve los campos que las
 * reglas de entrega/cancelación necesitan. DEBE llamarse dentro de una
 * transacción interactiva.
 *
 * El lock de fila —no la transacción por sí sola— es lo que serializa dos
 * requests concurrentes sobre el mismo pendiente: bajo READ COMMITTED (el
 * default de Postgres) una lectura plana no bloquea nada y ambos operadores
 * verían el mismo `deliveredQuantity`. Con FOR UPDATE la segunda transacción
 * espera acá hasta que la primera confirme, y recién entonces lee el estado ya
 * escrito. Así la sobre-entrega y la cancelación contra un estado obsoleto las
 * rechazan las reglas de negocio normales, en vez de pisarse en silencio.
 *
 * Devuelve `null` si el pendiente no existe.
 */
export async function lockPendingForUpdate(
  client: Prisma.TransactionClient,
  id: string,
): Promise<PendingForDelivery | null> {
  const rows = await client.$queryRaw<PendingForDelivery[]>`
    SELECT id, quantity, "deliveredQuantity", status
    FROM pendings WHERE id = ${id} FOR UPDATE
  `;
  return rows[0] ?? null;
}

export type CreatePendingDeliveryData = {
  pendingId: string;
  quantity: number;
  deliveredById: string;
};

export function createPendingDelivery(
  tx: Prisma.TransactionClient,
  data: CreatePendingDeliveryData,
) {
  return tx.pendingDelivery.create({
    data: {
      pendingId: data.pendingId,
      quantity: data.quantity,
      deliveredById: data.deliveredById,
    },
  });
}

export type UpdatePendingAfterDeliveryData = {
  id: string;
  // Estado leído bajo el lock. La escritura solo aplica si la fila sigue igual.
  expectedStatus: PendingStatus;
  expectedDeliveredQuantity: number;
  deliveredQuantity: number;
  status: PendingStatus;
  completedAt: Date | null;
};

/**
 * Compare-and-set: escribe solo si `status` y `deliveredQuantity` siguen siendo
 * los que se leyeron bajo el lock. Devuelve la cantidad de filas escritas (0 o
 * 1). Con `lockPendingForUpdate` tomado el CAS nunca falla; queda como guarda
 * de invariante para que un llamador futuro que se saltee el lock falle ruidoso
 * en vez de sobre-entregar en silencio.
 */
export async function updatePendingAfterDelivery(
  tx: Prisma.TransactionClient,
  data: UpdatePendingAfterDeliveryData,
): Promise<number> {
  const { count } = await tx.pending.updateMany({
    where: {
      id: data.id,
      status: data.expectedStatus,
      deliveredQuantity: data.expectedDeliveredQuantity,
    },
    data: {
      deliveredQuantity: data.deliveredQuantity,
      status: data.status,
      completedAt: data.completedAt,
    },
  });
  return count;
}

export type CancelPendingData = {
  id: string;
  // Estado leído bajo el lock: solo cancelamos si la fila no cambió desde ahí.
  expectedStatus: PendingStatus;
  cancelledById: string;
  cancelledAt: Date;
  cancelReason?: string;
};

/**
 * Compare-and-set de la cancelación: escribe solo si el pendiente sigue en el
 * estado leído bajo `lockPendingForUpdate`. Devuelve las filas escritas (0 o 1).
 * Impide que una cancelación pise una entrega concurrente que ya confirmó.
 */
export async function cancelPending(
  tx: Prisma.TransactionClient,
  data: CancelPendingData,
): Promise<number> {
  const { count } = await tx.pending.updateMany({
    where: { id: data.id, status: data.expectedStatus },
    data: {
      status: "CANCELADO",
      cancelledAt: data.cancelledAt,
      cancelledById: data.cancelledById,
      cancelReason: data.cancelReason ?? null,
    },
  });
  return count;
}

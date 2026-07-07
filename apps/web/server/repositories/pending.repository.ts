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
  product: { select: { id: true, name: true, code: true, unit: true } },
} as const;

export async function listPendings(params: {
  cursor?: string | null;
  take?: number;
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

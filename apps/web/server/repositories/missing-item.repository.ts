// --------------------------------------------------------------------------
// Repositorio de faltantes — ÚNICO lugar que toca Prisma para `MissingItem`.
// Listado SIEMPRE paginado (cursor-based). `originId` enlaza al pendiente que
// lo generó automáticamente; null = faltante manual (no implementado todavía).
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import {
  clampTake,
  decodeCursor,
  encodeCursor,
  type Paginated,
} from "@/lib/pagination";
import type {
  MissingItemStatus,
  PendingStatus,
  Prisma,
} from "@/lib/generated/prisma/client";

export type CloseMissingItemsByEntryParams = {
  productId: string;
  availableQuantity: number;
};

export type MissingItemListItem = {
  id: string;
  quantity: number;
  status: MissingItemStatus;
  originId: string | null;
  confirmedAt: Date | null;
  confirmedById: string | null;
  confirmationNote: string | null;
  orderedAt: Date | null;
  orderedById: string | null;
  supplierId: string | null;
  createdAt: Date;
  product: {
    id: string;
    name: string;
    code: string;
    unit: string;
    laboratory: { id: string; name: string } | null;
  };
  origin: {
    id: string;
    promisedAt: Date;
    status: PendingStatus;
    customerName: string | null;
  } | null;
  supplier: { id: string; name: string } | null;
};

export type CreateMissingItemData = {
  productId: string;
  quantity: number;
  originId?: string | null;
  createdById?: string | null;
};

export type MissingItemScope = "active" | "history";

export type ConfirmMissingItemData = {
  id: string;
  confirmedById: string;
  confirmedAt?: Date;
  note?: string;
};

export type OrderMissingItemData = {
  supplierId: string;
  orderedById: string;
  orderedAt: Date;
};

const LIST_SELECT = {
  id: true,
  quantity: true,
  status: true,
  originId: true,
  confirmedAt: true,
  confirmedById: true,
  confirmationNote: true,
  orderedAt: true,
  orderedById: true,
  supplierId: true,
  createdAt: true,
  product: {
    select: {
      id: true,
      name: true,
      code: true,
      unit: true,
      laboratory: { select: { id: true, name: true } },
    },
  },
  origin: {
    select: { id: true, promisedAt: true, status: true, customerName: true },
  },
  supplier: { select: { id: true, name: true } },
} as const;

export async function listMissingItems(params: {
  cursor?: string | null;
  take?: number;
  scope?: MissingItemScope;
}): Promise<Paginated<MissingItemListItem>> {
  const take = clampTake(params.take);
  let cursorId = params.cursor ? decodeCursor(params.cursor) : null;

  // El cursor es input controlado por el usuario. `decodeCursor` ya descarta la
  // basura (round-trip), pero un cursor bien formado puede apuntar a un id que
  // no existe (registro borrado o cursor inventado). Validamos su existencia con
  // un lookup barato por PK: si no existe, lo ignoramos y servimos la primera
  // página. Así un cursor inutilizable nunca rompe la consulta de paginación.
  if (cursorId) {
    const exists = await prisma.missingItem.findUnique({
      where: { id: cursorId },
      select: { id: true },
    });
    if (!exists) cursorId = null;
  }

  const rows = await prisma.missingItem.findMany({
    take: take + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    ...(params.scope === "history"
      ? {}
      : { where: { confirmedAt: null, status: { in: OPEN_STATUSES } } }),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: LIST_SELECT,
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.id) : null;

  return { items, nextCursor };
}

// Estados "abiertos": el faltante sigue requiriendo gestión (no resuelto).
const OPEN_STATUSES: MissingItemStatus[] = ["FALTANTE", "PEDIDO"];

export function countOpenMissingItems(): Promise<number> {
  return prisma.missingItem.count({
    where: { confirmedAt: null, status: { in: OPEN_STATUSES } },
  });
}

// Total histórico de faltantes (para reportería: cerrados = total - abiertos).
export function countAllMissingItems(): Promise<number> {
  return prisma.missingItem.count();
}

// Faltantes ya pedidos a un proveedor (chip "Pedidos" de la cola operativa).
export function countOrderedMissingItems(): Promise<number> {
  return prisma.missingItem.count({ where: { status: "PEDIDO" } });
}

// Faltantes con "OK gerencia". Se cuenta por `confirmedAt` —el hecho registrado—
// y no por estado: el service garantiza que un PEDIDO nunca queda confirmado.
export function countConfirmedMissingItems(): Promise<number> {
  return prisma.missingItem.count({ where: { confirmedAt: { not: null } } });
}

// Faltantes creados desde `since` (para el conteo "del día").
export function countMissingItemsCreatedSince(since: Date): Promise<number> {
  return prisma.missingItem.count({ where: { createdAt: { gte: since } } });
}

// Reportería: distribución por estado de los faltantes creados desde `since`.
export async function groupMissingItemsByStatusSince(
  since: Date,
): Promise<{ status: MissingItemStatus; count: number }[]> {
  const rows = await prisma.missingItem.groupBy({
    by: ["status"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });
  return rows.map((row) => ({ status: row.status, count: row._count._all }));
}

// Reportería: fechas de creación de faltantes desde `since`, para agrupar la
// tendencia por día en el service (bucketing en hora de Bogotá).
export async function listMissingItemCreatedAtSince(since: Date): Promise<Date[]> {
  const rows = await prisma.missingItem.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true },
  });
  return rows.map((row) => row.createdAt);
}

// Faltantes abiertos (sin confirmar) creados antes de `threshold`: los que llevan
// demasiado tiempo sin cerrarse. Base de la alerta de gerencia "no se han cerrado".
export function countUnclosedMissingItemsBefore(threshold: Date): Promise<number> {
  return prisma.missingItem.count({
    where: {
      confirmedAt: null,
      status: { in: OPEN_STATUSES },
      createdAt: { lt: threshold },
    },
  });
}

export function countOverdueMissingItems(now: Date = new Date()): Promise<number> {
  return prisma.missingItem.count({
    where: {
      status: { in: OPEN_STATUSES },
      confirmedAt: null,
      originId: { not: null },
      origin: { promisedAt: { lt: now } },
    },
  });
}

// `client` permite ejecutar dentro de una transacción (ver pending.service).
export async function createMissingItem(
  data: CreateMissingItemData,
  client: Prisma.TransactionClient = prisma,
) {
  return client.missingItem.create({
    data: {
      productId: data.productId,
      quantity: data.quantity,
      originId: data.originId ?? null,
      createdById: data.createdById ?? null,
    },
  });
}

// --------------------------------------------------------------------------
// closeMissingItemsByEntry
//
// Cierra faltantes abiertos para un producto usando FIFO (createdAt ASC) dentro
// de una transacción existente. El estado cerrado es RECIBIDO (el faltante fue
// suplido por la entrada). La cantidad disponible se resta item a item; si el
// siguiente item no cabe en el restante, se DETIENE (sin cierre parcial).
//
// Retorna el array de ids de los faltantes cerrados para que el llamador pueda
// registrar auditoría y mostrar el conteo en la UI.
// --------------------------------------------------------------------------
export async function closeMissingItemsByEntry(
  tx: Prisma.TransactionClient,
  params: CloseMissingItemsByEntryParams,
): Promise<string[]> {
  const openItems = await tx.missingItem.findMany({
    where: {
      productId: params.productId,
      status: { in: OPEN_STATUSES },
      confirmedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, quantity: true },
  });

  let remaining = params.availableQuantity;
  const closedIds: string[] = [];

  for (const item of openItems) {
    if (item.quantity > remaining) break;

    await tx.missingItem.update({
      where: { id: item.id },
      data: { status: "RECIBIDO" },
    });

    remaining -= item.quantity;
    closedIds.push(item.id);
  }

  return closedIds;
}

export type MissingItemForUpdate = {
  id: string;
  status: MissingItemStatus;
  confirmedAt: Date | null;
  confirmedById: string | null;
  confirmationNote: string | null;
  orderedAt: Date | null;
  orderedById: string | null;
  supplierId: string | null;
  productId: string;
};

/**
 * Bloquea (FOR UPDATE) la fila del faltante. DEBE llamarse dentro de una
 * transacción interactiva.
 *
 * Es lo que serializa las transiciones de estado del faltante: sin el lock, dos
 * gerentes pidiendo el mismo faltante a proveedores distintos leen ambos
 * `FALTANTE` y la última escritura gana, dejando la auditoría contradiciendo la
 * realidad. `orderMissingItem` y `confirmMissingItemOk` toman ESTE MISMO lock,
 * así que tampoco pueden cruzarse para producir el estado imposible
 * PEDIDO + confirmedAt.
 *
 * `productId` se incluye porque el pedido enlaza el producto con el proveedor.
 * Devuelve `null` si el faltante no existe.
 */
export async function lockMissingItemForUpdate(
  client: Prisma.TransactionClient,
  id: string,
): Promise<MissingItemForUpdate | null> {
  const rows = await client.$queryRaw<MissingItemForUpdate[]>`
    SELECT id, status, "confirmedAt", "confirmedById", "confirmationNote",
           "orderedAt", "orderedById", "supplierId", "productId"
    FROM missing_items WHERE id = ${id} FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Compare-and-set del pedido: escribe solo si el faltante sigue FALTANTE y sin
 * confirmar, tal como se leyó bajo el lock. Devuelve las filas escritas (0 o 1).
 * `tx` es obligatorio: esta escritura corre SIEMPRE dentro de la transacción del
 * pedido (lock + upserts + este update en un solo átomo), nunca suelta.
 */
export async function orderMissingItem(
  tx: Prisma.TransactionClient,
  id: string,
  data: OrderMissingItemData,
): Promise<number> {
  const { count } = await tx.missingItem.updateMany({
    where: { id, status: "FALTANTE", confirmedAt: null },
    data: {
      status: "PEDIDO",
      orderedAt: data.orderedAt,
      orderedById: data.orderedById,
      supplierId: data.supplierId,
    },
  });
  return count;
}

/**
 * Compare-and-set de la confirmación ("OK gerencia"): escribe solo si el
 * faltante sigue FALTANTE y sin confirmar. Refuerza la invariante del service:
 * un faltante que un pedido concurrente pasó a PEDIDO no coincide, así que la
 * confirmación no puede colarse y producir el estado imposible
 * PEDIDO + confirmedAt — incluso si un llamador futuro se saltea el lock de
 * fila. Devuelve las filas escritas (0 o 1). `tx` es obligatorio: corre bajo
 * el mismo lock que `orderMissingItem`.
 */
export async function confirmMissingItem(
  tx: Prisma.TransactionClient,
  data: ConfirmMissingItemData,
): Promise<number> {
  const { count } = await tx.missingItem.updateMany({
    where: { id: data.id, status: "FALTANTE", confirmedAt: null },
    data: {
      confirmedAt: data.confirmedAt ?? new Date(),
      confirmedById: data.confirmedById,
      confirmationNote: data.note ?? null,
    },
  });
  return count;
}

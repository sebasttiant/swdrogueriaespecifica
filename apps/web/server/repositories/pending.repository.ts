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
  const cursorId = params.cursor ? decodeCursor(params.cursor) : null;

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

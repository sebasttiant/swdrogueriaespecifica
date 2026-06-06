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
import type { MissingItemStatus, Prisma } from "@/lib/generated/prisma/client";

export type MissingItemListItem = {
  id: string;
  quantity: number;
  status: MissingItemStatus;
  originId: string | null;
  createdAt: Date;
  product: { id: string; name: string; code: string; unit: string };
};

export type CreateMissingItemData = {
  productId: string;
  quantity: number;
  originId?: string | null;
  createdById?: string | null;
};

const LIST_SELECT = {
  id: true,
  quantity: true,
  status: true,
  originId: true,
  createdAt: true,
  product: { select: { id: true, name: true, code: true, unit: true } },
} as const;

export async function listMissingItems(params: {
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<MissingItemListItem>> {
  const take = clampTake(params.take);
  const cursorId = params.cursor ? decodeCursor(params.cursor) : null;

  const rows = await prisma.missingItem.findMany({
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

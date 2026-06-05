// --------------------------------------------------------------------------
// Repositorio de lotes — ÚNICO lugar que toca Prisma para `ProductBatch`.
// Lectura paginada (cursor) por producto. Stock vendible por agregación SQL.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import {
  clampTake,
  decodeCursor,
  encodeCursor,
  type Paginated,
} from "@/lib/pagination";
import type { ProductBatch } from "@/lib/generated/prisma/client";

export type BatchListItem = Pick<
  ProductBatch,
  "id" | "batchCode" | "expiresAt" | "quantity" | "location" | "status"
>;

const LIST_SELECT = {
  id: true,
  batchCode: true,
  expiresAt: true,
  quantity: true,
  location: true,
  status: true,
} as const;

export async function listBatchesByProduct(params: {
  productId: string;
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<BatchListItem>> {
  const take = clampTake(params.take);
  const cursorId = params.cursor ? decodeCursor(params.cursor) : null;

  const rows = await prisma.productBatch.findMany({
    where: { productId: params.productId },
    take: take + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    // Los que vencen antes, primero (útil para revisar caducidades).
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    select: LIST_SELECT,
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.id) : null;

  return { items, nextCursor };
}

// Stock vendible: DISPONIBLE + con stock + no vencido. SUM por SQL, no en JS.
export async function stockByProduct(
  productId: string,
  now: Date = new Date(),
): Promise<number> {
  const result = await prisma.productBatch.aggregate({
    where: {
      productId,
      status: "DISPONIBLE",
      quantity: { gt: 0 },
      expiresAt: { gt: now },
    },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? 0;
}

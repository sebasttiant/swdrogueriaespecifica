// --------------------------------------------------------------------------
// Repositorio de productos — ÚNICO lugar que toca Prisma para `Product`.
// Listado SIEMPRE paginado (cursor-based). Nunca un findMany sin `take`.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import {
  clampTake,
  decodeCursor,
  encodeCursor,
  type Paginated,
} from "@/lib/pagination";
import type { Product } from "@/lib/generated/prisma/client";

export type ProductListItem = Pick<
  Product,
  "id" | "code" | "name" | "unit" | "minStock" | "reorderQty" | "active" | "createdAt"
>;

const LIST_SELECT = {
  id: true,
  code: true,
  name: true,
  unit: true,
  minStock: true,
  reorderQty: true,
  active: true,
  createdAt: true,
} as const;

export async function listProducts(params: {
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<ProductListItem>> {
  const take = clampTake(params.take);
  const cursorId = params.cursor ? decodeCursor(params.cursor) : null;

  // Pedimos take + 1 para saber si hay página siguiente sin un count extra.
  const rows = await prisma.product.findMany({
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

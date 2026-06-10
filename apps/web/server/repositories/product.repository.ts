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
> & {
  // Earliest expiry among batches with quantity > 0. Null if no active batches.
  // Used to compute per-product worst expiry tier in the catalog list (S3).
  worstExpiresAt: Date | null;
};

export type CreateProductData = {
  code: string;
  name: string;
  unit: string;
  minStock: number;
  reorderQty: number;
};

// Include the batch with the earliest expiry (quantity > 0) per product.
// Prisma does not support aggregate subqueries in select, so we include up to
// one batch ordered by expiresAt asc — the first result is the worst tier.
// This avoids N+1: one query per page, not one per product row.
const LIST_SELECT = {
  id: true,
  code: true,
  name: true,
  unit: true,
  minStock: true,
  reorderQty: true,
  active: true,
  createdAt: true,
  batches: {
    where: { quantity: { gt: 0 } },
    select: { expiresAt: true },
    orderBy: { expiresAt: "asc" as const },
    take: 1,
  },
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
  const rawItems = hasMore ? rows.slice(0, take) : rows;
  const last = rawItems.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.id) : null;

  // Map raw rows → ProductListItem: flatten worst batch expiry to a scalar.
  const items: ProductListItem[] = rawItems.map((row) => {
    const { batches, ...rest } = row;
    return {
      ...rest,
      worstExpiresAt: batches[0]?.expiresAt ?? null,
    };
  });

  return { items, nextCursor };
}

export async function findProductById(id: string): Promise<Product | null> {
  return prisma.product.findUnique({ where: { id } });
}

export async function createProduct(data: CreateProductData): Promise<Product> {
  return prisma.product.create({ data });
}

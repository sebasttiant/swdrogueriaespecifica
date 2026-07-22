// --------------------------------------------------------------------------
// Servicio de productos (server-only). Boundary de negocio: la página/acción
// delega acá y nunca toca el repositorio directo. Hoy es fino; crece con las
// reglas.
// --------------------------------------------------------------------------

import type { Paginated } from "@/lib/pagination";
import type { Product } from "@/lib/generated/prisma/client";
import {
  createProduct,
  findProductById,
  listProducts,
  type CreateProductData,
  type ProductListItem,
} from "@/server/repositories/product.repository";

export function getProducts(params: {
  cursor?: string | null;
  take?: number;
  q?: string;
  active?: boolean;
}): Promise<Paginated<ProductListItem>> {
  return listProducts(params);
}

export type ActiveProductOption = Pick<ProductListItem, "id" | "name" | "code">;

export async function getActiveProductsForMissingItem(params: {
  cursor?: string | null;
  q: string;
}): Promise<Paginated<ActiveProductOption>> {
  const page = await getProducts({
    active: true,
    q: params.q,
    take: 20,
    ...(params.cursor ? { cursor: params.cursor } : {}),
  });

  return {
    items: page.items
      .filter((product) => product.active)
      .map(({ id, name, code }) => ({ id, name, code })),
    nextCursor: page.nextCursor,
  };
}

export function getProduct(id: string): Promise<Product | null> {
  return findProductById(id);
}

export function addProduct(data: CreateProductData): Promise<Product> {
  return createProduct(data);
}

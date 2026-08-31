// --------------------------------------------------------------------------
// Servicio de productos (server-only). Boundary de negocio: la página/acción
// delega acá y nunca toca el repositorio directo. Hoy es fino; crece con las
// reglas.
// --------------------------------------------------------------------------

import type { Paginated } from "@/lib/pagination";
import type { Product } from "@/lib/generated/prisma/client";
import {
  createProduct,
  updateProduct,
  type UpdateProductData,
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

/**
 * Edita los datos de catálogo de un producto y devuelve el ANTES y el DESPUÉS.
 *
 * Devuelve los dos a propósito: quien audita necesita saber qué cambió, no
 * solo cómo quedó. "El laboratorio ahora es Genfar" no dice nada; "era Bayer y
 * ahora es Genfar" es lo que permite entender una decisión seis meses después.
 *
 * Devuelve `null` si el producto no existe, en vez de tirar: para la acción es
 * un 404, no un error del sistema.
 */
export async function editProduct(
  id: string,
  data: UpdateProductData,
): Promise<{ before: Product; after: Product } | null> {
  const before = await findProductById(id);
  if (!before) return null;
  const after = await updateProduct(id, data);
  return { before, after };
}

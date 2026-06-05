// --------------------------------------------------------------------------
// Servicio de productos (server-only). Boundary de negocio: la página/acción
// delega acá y nunca toca el repositorio directo. Hoy es fino; crece con las
// reglas.
// --------------------------------------------------------------------------

import type { Paginated } from "@/lib/pagination";
import type { Product } from "@/lib/generated/prisma/client";
import {
  createProduct,
  listProducts,
  type CreateProductData,
  type ProductListItem,
} from "@/server/repositories/product.repository";

export function getProducts(params: {
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<ProductListItem>> {
  return listProducts(params);
}

export function addProduct(data: CreateProductData): Promise<Product> {
  return createProduct(data);
}

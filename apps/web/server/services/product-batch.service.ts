// --------------------------------------------------------------------------
// Servicio de lotes (server-only, lectura). Boundary: la página delega acá y
// no toca el repositorio directo. Las mutaciones llegan en el slice 2b-B.
// --------------------------------------------------------------------------

import type { Paginated } from "@/lib/pagination";
import {
  listBatchesByProduct,
  stockByProduct,
  type BatchListItem,
} from "@/server/repositories/product-batch.repository";

export function getBatchesByProduct(params: {
  productId: string;
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<BatchListItem>> {
  return listBatchesByProduct(params);
}

export function getSellableStock(productId: string): Promise<number> {
  return stockByProduct(productId);
}

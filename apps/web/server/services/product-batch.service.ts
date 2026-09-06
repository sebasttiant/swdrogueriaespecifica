// --------------------------------------------------------------------------
// Servicio de lotes (server-only, lectura). Boundary: la página delega acá y
// no toca el repositorio directo. Las mutaciones llegan en el slice 2b-B.
// --------------------------------------------------------------------------

import type { Paginated } from "@/lib/pagination";
import type { ExpiryTier } from "@/lib/inventory/batch-status";
import {
  listBatchesByProduct,
  listExpiringBatches,
  stockByProduct,
  countExpiringBatches,
  type BatchListItem,
  type ExpiringBatchCounts,
  type ExpiringBatchListItem,
} from "@/server/repositories/product-batch.repository";

export type { ExpiringBatchCounts, ExpiringBatchListItem };

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

/**
 * Returns the count of expiring batches per tier (calendar-day Bogota).
 * Dashboard KPI and alert bar consume this service — never the repo directly.
 * D2: the dashboard KPI uses critical + warning (excludes expired).
 */
export function getExpiringBatchCounts(
  now?: Date,
): Promise<ExpiringBatchCounts> {
  return countExpiringBatches(now);
}

/**
 * Los lotes de una franja de vencimiento, paginados. Es la lista que abre el
 * chip de la barra de alertas: mismo `where` que el contador que lo pinta.
 */
export function getExpiringBatches(params: {
  tier: ExpiryTier;
  cursor?: string | null;
  take?: number;
  now?: Date;
}): Promise<Paginated<ExpiringBatchListItem>> {
  return listExpiringBatches(params);
}

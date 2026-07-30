// --------------------------------------------------------------------------
// Servicio de entradas de inventario (server-only). Boundary de negocio del
// caso de uso "registrar una entrada de stock".
//
// Slice 1: registerInventoryEntry — UNA transacción con DOS escrituras:
//   1. upsertBatchQuantity: crea o incrementa el lote físico en ProductBatch.
//   2. createInventoryEntry: escribe la fila de ledger en InventoryEntry.
//
// Slice 2: closeMissingItemsByEntry — dentro de la MISMA transacción, cierra
// faltantes abiertos para el producto usando FIFO. Atómico: stock, ledger y
// reconciliación de faltantes se confirman o revierten juntos.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { Paginated } from "@/lib/pagination";
import {
  closeMissingItemsByEntry,
  listArrivedMissingItems,
} from "@/server/repositories/missing-item.repository";
import { markReportsReceivedByMissingItemIds } from "@/server/repositories/missing-report.repository";
import { upsertBatchQuantity } from "@/server/repositories/product-batch.repository";
import {
  createInventoryEntry,
  listInventoryEntries,
  type InventoryEntryListItem,
} from "@/server/repositories/inventory-entry.repository";

export type RegisterInventoryEntryInput = {
  productId: string;
  quantity: number;
  batchCode: string;
  expiresAt: Date;
  note?: string;
  createdById?: string | null;
};

export type RegisterInventoryEntryResult = {
  entry: { id: string };
  closedMissingCount: number;
};

/**
 * Registra una entrada de inventario de forma atómica:
 * 1. Upsert del lote físico (ProductBatch) por (productId, batchCode).
 * 2. Inserción del registro de ledger (InventoryEntry).
 * 3. Cierre FIFO de faltantes abiertos para el producto (closeMissingItemsByEntry).
 *
 * Si cualquiera de las tres escrituras falla, Prisma revierte todo.
 */
export async function registerInventoryEntry(
  data: RegisterInventoryEntryInput,
): Promise<RegisterInventoryEntryResult> {
  return prisma.$transaction(async (tx) => {
    await upsertBatchQuantity(tx, {
      productId: data.productId,
      batchCode: data.batchCode,
      expiresAt: data.expiresAt,
      quantity: data.quantity,
    });

    const entry = await createInventoryEntry(tx, {
      productId: data.productId,
      quantity: data.quantity,
      note: data.note,
      createdById: data.createdById,
    });

    const closedIds = await closeMissingItemsByEntry(tx, {
      productId: data.productId,
      availableQuantity: data.quantity,
    });
    await markReportsReceivedByMissingItemIds(tx, closedIds);

    return { entry, closedMissingCount: closedIds.length };
  });
}

// Boundary de lectura para la UI — la página delega acá, nunca al repo directo.
export function getInventoryEntries(params: {
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<InventoryEntryListItem>> {
  return listInventoryEntries(params);
}

export function getArrivedMissingItems() {
  return listArrivedMissingItems();
}

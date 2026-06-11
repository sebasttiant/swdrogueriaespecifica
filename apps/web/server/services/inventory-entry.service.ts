// --------------------------------------------------------------------------
// Servicio de entradas de inventario (server-only). Boundary de negocio del
// caso de uso "registrar una entrada de stock".
//
// Slice 1: registerInventoryEntry — UNA transacción con DOS escrituras:
//   1. upsertBatchQuantity: crea o incrementa el lote físico en ProductBatch.
//   2. createInventoryEntry: escribe la fila de ledger en InventoryEntry.
//
// Slice 2 (futuro): añadir closeMissingItemsByEntry dentro de la misma $tx
// para cerrar faltantes abiertos por FIFO. NO implementado en este slice.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { Paginated } from "@/lib/pagination";
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
};

/**
 * Registra una entrada de inventario de forma atómica:
 * 1. Upsert del lote físico (ProductBatch) por (productId, batchCode).
 * 2. Inserción del registro de ledger (InventoryEntry).
 *
 * Si cualquiera de las dos escrituras falla, Prisma revierte ambas.
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

    return { entry };
  });
}

// Boundary de lectura para la UI — la página delega acá, nunca al repo directo.
export function getInventoryEntries(params: {
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<InventoryEntryListItem>> {
  return listInventoryEntries(params);
}

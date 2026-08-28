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
import {
  lockBatchLaboratoryEvidence,
  reserveReceivedBatchQuantity,
  reserveBatchForPending,
  upsertBatchQuantity,
} from "@/server/repositories/product-batch.repository";
import {
  createInventoryEntry,
  findInventoryEntryByIdempotencyKey,
  listInventoryEntries,
  type InventoryEntryListItem,
} from "@/server/repositories/inventory-entry.repository";
import {
  enqueuePendingAvailabilityNotification,
  type AvailabilityStatus,
} from "@/server/services/notification-outbox.service";

export type RegisterInventoryEntryInput = {
  productId: string;
  quantity: number;
  batchCode: string;
  expiresAt: Date;
  note?: string;
  createdById?: string | null;
  idempotencyKey?: string;
  /**
   * Laboratorio OBSERVADO al recibir la mercadería. Es un tercer eje, separado
   * del laboratorio SOLICITADO (`Pending`/`MissingItem.requestedLaboratoryId`)
   * y del de CATÁLOGO (`Product.laboratoryId`): lo que el cliente pidió, lo que
   * el catálogo dice y lo que bodega tuvo en la mano son tres hechos distintos
   * y ninguno puede escribir sobre otro.
   */
  receivedLaboratoryId?: string | null;
};

export type RegisterInventoryEntryResult = {
  entry: { id: string };
  allocatedMissingCount: number;
  /** @deprecated compatibility alias; counts allocation recipients. */
  closedMissingCount: number;
  idempotent: boolean;
};

export class IdempotencyPayloadConflictError extends Error {
  constructor() { super("idempotency key was already used for a different entry payload"); }
}

/**
 * El lote ya fue recibido con OTRO laboratorio.
 *
 * Se rechaza la entrada entera en vez de preservar o pisar la evidencia previa:
 * las dos alternativas silenciosas dejan un lote afirmando un laboratorio que
 * alguien no recibió, y eso no se descubre hasta que ya no se puede reconstruir.
 * Un rechazo es visible y se corrige en el momento.
 *
 * Lleva el NOMBRE del laboratorio y el código de lote —nunca ids internos—
 * porque el destinatario del mensaje es la persona que está cargando la caja.
 */
export class LaboratoryEvidenceConflictError extends Error {
  readonly batchCode: string;
  readonly existingLaboratoryName: string | null;

  constructor(params: { batchCode: string; existingLaboratoryName: string | null }) {
    super("batch already received with a different laboratory");
    this.batchCode = params.batchCode;
    this.existingLaboratoryName = params.existingLaboratoryName;
  }
}

function requestFingerprint(data: RegisterInventoryEntryInput): string {
  return JSON.stringify({
    productId: data.productId, quantity: data.quantity, batchCode: data.batchCode,
    expiresAt: data.expiresAt.toISOString(),
    note: data.note?.trim() || null,
    createdById: data.createdById ?? null,
    // La clave se OMITE cuando no hay laboratorio, y va al final a propósito.
    // Así el JSON de toda entrada sin laboratorio es byte a byte el mismo de
    // antes de este campo: un reintento que cruce el despliegue compara contra
    // su fingerprint guardado y coincide, en vez de fallar por un conflicto de
    // payload que nadie provocó.
    ...(data.receivedLaboratoryId
      ? { receivedLaboratoryId: data.receivedLaboratoryId }
      : {}),
  });
}

function isUniqueConstraint(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

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
  try {
    return await prisma.$transaction(async (tx) => {
    const fingerprint = requestFingerprint(data);
    if (data.idempotencyKey) {
      const existing = await findInventoryEntryByIdempotencyKey(tx, data.idempotencyKey);
      if (existing) {
        if (existing.requestFingerprint !== undefined && existing.requestFingerprint !== fingerprint) throw new IdempotencyPayloadConflictError();
        return { entry: existing, allocatedMissingCount: 0, closedMissingCount: 0, idempotent: true };
      }
    }
    const idempotencyKey = data.idempotencyKey ?? crypto.randomUUID();

    // La evidencia de laboratorio se decide ANTES de tocar el lote. El lock es
    // lo que hace que la comparación signifique algo bajo concurrencia.
    if (data.receivedLaboratoryId) {
      const locked = await lockBatchLaboratoryEvidence(tx, {
        productId: data.productId,
        batchCode: data.batchCode,
      });
      // `null` en el lote es AUSENCIA de evidencia, no un valor en conflicto:
      // un lote histórico acepta la primera observación que llegue.
      if (
        locked?.receivedLaboratoryId &&
        locked.receivedLaboratoryId !== data.receivedLaboratoryId
      ) {
        throw new LaboratoryEvidenceConflictError({
          batchCode: data.batchCode,
          existingLaboratoryName: locked.receivedLaboratoryName,
        });
      }
    }

    const batch = await upsertBatchQuantity(tx, {
      productId: data.productId,
      batchCode: data.batchCode,
      expiresAt: data.expiresAt,
      quantity: data.quantity,
      ...(data.receivedLaboratoryId
        ? { receivedLaboratoryId: data.receivedLaboratoryId }
        : {}),
    });

    const entry = await createInventoryEntry(tx, {
      productId: data.productId,
      quantity: data.quantity,
      note: data.note,
      createdById: data.createdById,
      idempotencyKey,
      requestFingerprint: fingerprint,
    });

    // Compatibilidad segura con recepciones heredadas que no traen operation id.
    if (!data.idempotencyKey) {
      const closedIds = await closeMissingItemsByEntry(tx, { productId: data.productId, availableQuantity: data.quantity });
      await markReportsReceivedByMissingItemIds(tx, closedIds);
      return { entry, allocatedMissingCount: closedIds.length, closedMissingCount: closedIds.length, idempotent: false };
    }
    // FIFO cuantitativo: se bloquean los faltantes del producto y cada unidad de
    // esta entrada queda ligada a exactamente un faltante. Los parciales quedan
    // registrados, nunca se salta una necesidad sin consumir cantidad.
    const rows = await tx.$queryRaw<Array<{
      id: string; quantity: number; orderedQuantity: number | null; receivedQuantity: number; originId: string | null;
    }>>`SELECT id, quantity, "orderedQuantity", "receivedQuantity", "originId" FROM missing_items WHERE "productId" = ${data.productId} AND status IN ('FALTANTE', 'PEDIDO', 'EN_BODEGA') AND "receivedQuantity" < CASE WHEN "originId" IS NULL THEN COALESCE("orderedQuantity", quantity) ELSE quantity END ORDER BY "createdAt" ASC, id ASC FOR UPDATE`;
    let remaining = data.quantity;
    let reservedQuantity = 0;
    let allocatedMissingCount = 0;
    const closedMissingIds: string[] = [];
    for (const item of rows) {
      if (remaining === 0) break;
      const needed = item.originId === null ? (item.orderedQuantity ?? item.quantity) : item.quantity;
      const allocated = Math.min(remaining, needed - item.receivedQuantity);
      if (allocated <= 0) continue;
      const receivedQuantity = item.receivedQuantity + allocated;
      await tx.inventoryAllocation.create({ data: {
        inventoryEntryId: entry.id, missingItemId: item.id, pendingId: item.originId,
        quantity: allocated,
      }});
      // Una recepción PARCIAL no cambia de estado (D10). Antes pasaba a
      // EN_BODEGA, y eso le daba dos significados al mismo valor: "recepción
      // intentada, no confirmada" —lo que escribe `markMissingItemArrived`, y
      // lo que además le avisa al pendiente del vendedor— y "recibido a
      // medias". Un parcial YA se confirmó, así que el ítem sigue siendo lo
      // que era: un PEDIDO al que le falta mercadería, o un FALTANTE que nadie
      // pidió pero al que igual le entró stock. Solo completarlo lo cierra.
      await tx.missingItem.update({ where: { id: item.id }, data: {
        receivedQuantity,
        ...(receivedQuantity === needed ? { status: "RECIBIDO" as const } : {}),
      }});
      if (item.originId) {
        const pending = await tx.pending.findUniqueOrThrow({ where: { id: item.originId }, select: { quantity: true, inventoryReadyQuantity: true, reservedInventoryQuantity: true } });
        const inventoryReadyQuantity = Math.min(pending.quantity, pending.inventoryReadyQuantity + allocated);
        const availabilityStatus: AvailabilityStatus =
          inventoryReadyQuantity === pending.quantity ? "DISPONIBLE_COMPLETO" : "DISPONIBLE_PARCIAL";
        await tx.pending.update({ where: { id: item.originId }, data: {
          inventoryReadyQuantity,
          reservedInventoryQuantity: pending.reservedInventoryQuantity + allocated,
          availabilityStatus,
        }});
        // Avisa al vendedor que su pendiente ya tiene stock disponible. DENTRO
        // de la transacción: si el batch se revierte, la notificación también.
        await enqueuePendingAvailabilityNotification(
          { pendingId: item.originId, availabilityStatus },
          tx,
        );
        await reserveBatchForPending(tx, item.originId, batch.id, allocated);
      }
      remaining -= allocated;
      // A manual MissingItem has no customer Pending. Receiving it closes the
      // purchasing/report workflow but leaves the physical units sellable.
      if (item.originId) reservedQuantity += allocated;
      allocatedMissingCount += 1;
      if (receivedQuantity === needed) closedMissingIds.push(item.id);
    }
    if (reservedQuantity > 0) {
      await reserveReceivedBatchQuantity(tx, batch.id, reservedQuantity);
    }
    await markReportsReceivedByMissingItemIds(tx, closedMissingIds);
    return { entry, allocatedMissingCount, closedMissingCount: allocatedMissingCount, idempotent: false };
    });
  } catch (error) {
    // A simultaneous retry can pass the preflight read in both transactions.
    // The unique index chooses one winner; return that committed ledger entry.
    if (data.idempotencyKey && isUniqueConstraint(error)) {
      const entry = await findInventoryEntryByIdempotencyKey(prisma, data.idempotencyKey);
      if (entry) {
        if (entry.requestFingerprint !== undefined && entry.requestFingerprint !== requestFingerprint(data)) throw new IdempotencyPayloadConflictError();
        return { entry, allocatedMissingCount: 0, closedMissingCount: 0, idempotent: true };
      }
    }
    throw error;
  }
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

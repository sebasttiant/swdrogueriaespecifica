import { createHash } from "node:crypto";

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import type { AdjustmentReason } from "@/features/inventario/adjustment-reason";
import {
  recordAuditInTransaction,
  type TransactionalAuditWriter,
} from "@/server/services/transactional-audit.service";

// --------------------------------------------------------------------------
// Corrección manual del stock de un lote.
//
// Hasta ahora la única forma de corregir una diferencia de conteo era un UPDATE
// a mano contra la base. Eso deja el número cambiado y nada más: sin motivo,
// sin responsable y sin forma de reconstruir qué pasó. Seis meses después nadie
// puede explicar por qué el inventario dice lo que dice, y ese es exactamente
// el estado en el que encontramos las unidades fantasma de SEDATIF y de
// PROBIOESEENS.
//
// Acá el ajuste es un HECHO REGISTRADO: cuántas unidades, por qué, quién y
// cuándo, todo en la misma transacción que mueve el número. Si la auditoría
// falla, el ajuste se revierte entero.
//
// Actúa sobre `product_batches` porque ese es el modelo vivo: es lo que lee la
// pantalla del producto y lo que `claimableStockForPending` consulta al crear
// un pendiente. El ledger canónico (`lots`/`inventory_movements`) existe pero
// todavía no lo llama ningún flujo, así que un ajuste allá no cambiaría nada de
// lo que ve la droguería.
// --------------------------------------------------------------------------

const COMMAND_TYPE = "inventory.adjust";

/** El lote no existe: no hay nada que corregir. */
export class BatchNotFoundError extends Error {
  constructor(readonly batchId: string) {
    super(`batch ${batchId} was not found`);
    this.name = "BatchNotFoundError";
  }
}

/** El ajuste dejaría el lote en negativo. */
export class AdjustmentBelowZeroError extends Error {
  constructor(
    readonly batchId: string,
    readonly quantity: number,
    readonly quantityDelta: number,
  ) {
    super(`batch ${batchId} holds ${quantity}, cannot apply ${quantityDelta}`);
    this.name = "AdjustmentBelowZeroError";
  }
}

/**
 * El ajuste sacaría mercadería ya prometida a un cliente.
 *
 * Es la guarda que de verdad importa. Dejar el lote por debajo de lo reservado
 * no se ve en ninguna pantalla de inventario: se ve cuando la persona viene al
 * mostrador a buscar su pedido y no está.
 */
export class AdjustmentBelowReservedError extends Error {
  constructor(
    readonly batchId: string,
    readonly reserved: number,
    readonly resultingQuantity: number,
  ) {
    super(
      `batch ${batchId} has ${reserved} reserved, cannot leave ${resultingQuantity}`,
    );
    this.name = "AdjustmentBelowReservedError";
  }
}

/** La misma clave de intento con otro contenido: es un error, no un reintento. */
export class AdjustmentIdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`idempotency key ${idempotencyKey} was used for a different adjustment`);
    this.name = "AdjustmentIdempotencyConflictError";
  }
}

export type AdjustBatchQuantityInput = {
  batchId: string;
  /** Quién ajusta. Queda en el asiento de auditoría. */
  actorId: string;
  /**
   * Cantidad FINAL deseada tras el conteo. El delta se calcula DESPUÉS del
   * lock: si alguien ajustó el mismo lote en el medio, no se aplica un delta
   * viejo calculado contra una cantidad que ya no es.
   */
  targetQuantity: number;
  reason: AdjustmentReason;
  /** Detalle libre opcional. El motivo estructurado va aparte. */
  note?: string | null;
  /** Clave del INTENTO: un reenvío con la misma clave no ajusta dos veces. */
  idempotencyKey: string;
};

export type AdjustBatchQuantityResult = {
  batchId: string;
  quantityBefore: number;
  quantityAfter: number;
  /** True cuando este intento ya se había aplicado y se devuelve lo guardado. */
  replayed: boolean;
};

/** SHA-256 del contenido: ata la clave de idempotencia a lo que se pidió. */
function fingerprintOf(input: AdjustBatchQuantityInput): string {
  const canonical = JSON.stringify({
    batchId: input.batchId,
    targetQuantity: input.targetQuantity,
    reason: input.reason,
    note: input.note ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function adjustBatchQuantity(
  input: AdjustBatchQuantityInput,
  deps: { writeAudit?: TransactionalAuditWriter } = {},
): Promise<AdjustBatchQuantityResult> {
  // Una cantidad final negativa no es un conteo: se rechaza antes de abrir
  // la transacción. El "no hay cambio" (target = cantidad actual) se detecta
  // DESPUÉS del lock, cuando ya se sabe cuánto hay de verdad.
  if (!Number.isInteger(input.targetQuantity) || input.targetQuantity < 0) {
    throw new RangeError(
      `targetQuantity must be a non-negative integer, received ${input.targetQuantity}`,
    );
  }

  const writeAudit = deps.writeAudit ?? recordAuditInTransaction;
  const fingerprint = fingerprintOf(input);

  return prisma.$transaction(async (tx) => {
    // El reintento se resuelve ANTES de tocar nada: si este intento ya se
    // aplicó, se devuelve lo que quedó en vez de ajustar una segunda vez.
    const known = await tx.operationalCommand.findUnique({
      where: {
        actorId_commandType_commandKey: {
          actorId: input.actorId,
          commandType: COMMAND_TYPE,
          commandKey: input.idempotencyKey,
        },
      },
    });
    if (known) {
      if (known.fingerprint !== fingerprint) {
        throw new AdjustmentIdempotencyConflictError(input.idempotencyKey);
      }
      const stored = known.result as {
        quantityBefore: number;
        quantityAfter: number;
      } | null;
      return {
        batchId: input.batchId,
        quantityBefore: stored?.quantityBefore ?? 0,
        quantityAfter: stored?.quantityAfter ?? 0,
        replayed: true,
      };
    }

    // FOR UPDATE serializa a quien toque ESTE lote. Sin el lock, dos ajustes
    // simultáneos leen la misma cantidad vieja y el segundo pisa al primero.
    const locked = await tx.$queryRaw<{ quantity: number }[]>`
      SELECT quantity FROM product_batches
       WHERE id = ${input.batchId}
       FOR UPDATE
    `;
    const batch = locked.at(0);
    if (!batch) throw new BatchNotFoundError(input.batchId);

    const quantityBefore = batch.quantity;
    const quantityAfter = input.targetQuantity;
    const quantityDelta = quantityAfter - quantityBefore;

    // Pedir la misma cantidad que ya hay no corrige nada y dejaría un asiento
    // que no explica ningún cambio.
    if (quantityDelta === 0) {
      throw new RangeError(
        `targetQuantity ${input.targetQuantity} matches current quantity; nothing to adjust`,
      );
    }

    if (quantityAfter < 0) {
      throw new AdjustmentBelowZeroError(
        input.batchId,
        quantityBefore,
        quantityDelta,
      );
    }

    // Lo prometido sale de la tabla de reservas, no de una columna acumulada:
    // es lo único que dice cuántas unidades de ESTE lote tienen dueño hoy.
    const { _sum } = await tx.pendingInventoryReservation.aggregate({
      where: { batchId: input.batchId },
      _sum: { quantity: true },
    });
    const reserved = _sum.quantity ?? 0;

    if (quantityAfter < reserved) {
      throw new AdjustmentBelowReservedError(
        input.batchId,
        reserved,
        quantityAfter,
      );
    }

    await tx.productBatch.update({
      where: { id: input.batchId },
      data: { quantity: quantityAfter },
    });

    // El asiento va en la MISMA transacción: un ajuste sin rastro es
    // indistinguible del UPDATE a mano que esto vino a reemplazar.
    await writeAudit(tx, {
      action: AUDIT_ACTIONS.INVENTORY_ADJUST,
      module: AUDIT_MODULES.ENTRADAS,
      entity: "ProductBatch",
      entityId: input.batchId,
      before: { quantity: quantityBefore },
      after: {
        quantity: quantityAfter,
        quantityDelta,
        reason: input.reason,
        note: input.note ?? null,
      },
      context: { userId: input.actorId },
    });

    // El comando se registra DESPUÉS del efecto y con su resultado: así el
    // reintento devuelve exactamente lo que pasó, no lo que se pretendía.
    await tx.operationalCommand.create({
      data: {
        actorId: input.actorId,
        commandType: COMMAND_TYPE,
        commandKey: input.idempotencyKey,
        fingerprint,
        result: { batchId: input.batchId, quantityBefore, quantityAfter },
      },
    });

    return { batchId: input.batchId, quantityBefore, quantityAfter, replayed: false };
  });
}

import type { Prisma } from "@/lib/generated/prisma/client";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  releasePendingReservations,
  reserveBatchForPending,
  stockByProduct,
} from "@/server/repositories/product-batch.repository";
import { createMissingItem } from "@/server/repositories/missing-item.repository";
import type { TransactionalAuditWriter } from "@/server/services/transactional-audit.service";

// --------------------------------------------------------------------------
// Reclamo de pendientes cuando el stock físico ya no cubre lo prometido.
//
// `inventoryReadyQuantity` + `DISPONIBLE_COMPLETO` es una PROMESA blanda: no
// mueve `product_batches.quantity`, pero la pantalla dice "Ya llegó". Si el
// estante baja (ajuste, corrección) y nadie reclama esa promesa, el falso
// arribo queda vivo — exactamente PROBIO / WELLBUTRIN / GLAUCOMED.
//
// Esta rutina deja la suma de lo reclamado por pendientes abiertos ≤ stock
// DISPONIBLE del producto. Conserva primero a quien llegó antes
// (`createdAt` ASC). Reescribe reservas de lote para que coincidan con lo
// que quedó reclamado, y abre/ajusta el faltante por el déficit.
// --------------------------------------------------------------------------

export type ClaimReconcileResult = {
  productId: string;
  physicalStock: number;
  clampedPendingIds: string[];
};

function availabilityFor(quantity: number, ready: number) {
  if (ready <= 0) return "ESPERANDO" as const;
  if (ready >= quantity) return "DISPONIBLE_COMPLETO" as const;
  return "DISPONIBLE_PARCIAL" as const;
}

/**
 * Baja reservas de UN lote hasta `cap`, empezando por los pendientes más
 * nuevos. Sin esto, un ajuste no podría dejar el lote por debajo de lo que
 * todavía figura reservado en filas viejas.
 */
export async function trimBatchReservationsToCap(
  tx: Prisma.TransactionClient,
  batchId: string,
  cap: number,
): Promise<void> {
  if (cap < 0) throw new RangeError(`cap must be >= 0, received ${cap}`);

  const rows = await tx.$queryRaw<
    { id: string; pendingId: string; quantity: number }[]
  >`
    SELECT r.id, r."pendingId", r.quantity
      FROM pending_inventory_reservations r
      JOIN pendings p ON p.id = r."pendingId"
     WHERE r."batchId" = ${batchId}
     ORDER BY p."createdAt" DESC, r.id DESC
     FOR UPDATE OF r
  `;

  let total = rows.reduce((sum, row) => sum + row.quantity, 0);
  for (const row of rows) {
    if (total <= cap) break;
    const excess = total - cap;
    const remove = Math.min(row.quantity, excess);
    if (remove === row.quantity) {
      await tx.pendingInventoryReservation.delete({ where: { id: row.id } });
    } else {
      await tx.pendingInventoryReservation.update({
        where: { id: row.id },
        data: { quantity: { decrement: remove } },
      });
    }
    total -= remove;
  }
}

async function rebuildSoftReservations(
  tx: Prisma.TransactionClient,
  pendingId: string,
  productId: string,
  keep: number,
  now: Date,
): Promise<number> {
  await releasePendingReservations(tx, pendingId);
  if (keep <= 0) return 0;

  const batches = await tx.productBatch.findMany({
    where: {
      productId,
      status: "DISPONIBLE",
      quantity: { gt: 0 },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
    select: { id: true, quantity: true },
  });

  let left = keep;
  for (const batch of batches) {
    if (left <= 0) break;
    const { _sum } = await tx.pendingInventoryReservation.aggregate({
      where: { batchId: batch.id },
      _sum: { quantity: true },
    });
    const freeOnBatch = Math.max(batch.quantity - (_sum.quantity ?? 0), 0);
    const take = Math.min(freeOnBatch, left);
    if (take <= 0) continue;
    await reserveBatchForPending(tx, pendingId, batch.id, take);
    left -= take;
  }
  return keep - left;
}

async function upsertDeficitMissingItem(
  tx: Prisma.TransactionClient,
  input: {
    pendingId: string;
    productId: string;
    deficit: number;
    actorId: string;
  },
): Promise<void> {
  const existing = await tx.missingItem.findFirst({
    where: {
      originId: input.pendingId,
      status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (input.deficit <= 0) {
    if (existing) {
      await tx.missingItem.update({
        where: { id: existing.id },
        data: { status: "CANCELADO" },
      });
    }
    return;
  }

  if (existing) {
    await tx.missingItem.update({
      where: { id: existing.id },
      data: { quantity: input.deficit },
    });
    return;
  }

  await createMissingItem(
    {
      productId: input.productId,
      quantity: input.deficit,
      originId: input.pendingId,
      createdById: input.actorId,
      status: "FALTANTE",
    },
    tx,
  );
}

/**
 * Alinea promesas abiertas del producto con el stock físico DISPONIBLE.
 */
export async function reconcilePendingClaimsForProduct(
  tx: Prisma.TransactionClient,
  input: {
    productId: string;
    actorId: string;
    writeAudit: TransactionalAuditWriter;
    reason: string;
  },
): Promise<ClaimReconcileResult> {
  const now = new Date();
  const physicalStock = await stockByProduct(input.productId, now, tx);

  const pendings = await tx.pending.findMany({
    where: {
      productId: input.productId,
      status: { notIn: ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      quantity: true,
      inventoryReadyQuantity: true,
      reservedInventoryQuantity: true,
      availabilityStatus: true,
    },
  });

  let remaining = physicalStock;
  const clampedPendingIds: string[] = [];

  for (const pending of pendings) {
    const keepTarget = Math.min(
      pending.inventoryReadyQuantity,
      pending.quantity,
      remaining,
    );

    // Las reservas se reconstruyen contra el cupo: pueden estar desfasadas del
    // ready (GLAUCOMED: 15 reservadas con 5 en estante).
    const placed = await rebuildSoftReservations(
      tx,
      pending.id,
      input.productId,
      keepTarget,
      now,
    );
    const keep = Math.min(keepTarget, placed);
    remaining -= keep;

    if (
      keep === pending.inventoryReadyQuantity &&
      keep === pending.reservedInventoryQuantity &&
      placed === keepTarget
    ) {
      continue;
    }

    const availabilityStatus = availabilityFor(pending.quantity, keep);
    await tx.pending.update({
      where: { id: pending.id },
      data: {
        inventoryReadyQuantity: keep,
        reservedInventoryQuantity: keep,
        availabilityStatus,
      },
    });

    await upsertDeficitMissingItem(tx, {
      pendingId: pending.id,
      productId: input.productId,
      deficit: pending.quantity - keep,
      actorId: input.actorId,
    });

    await input.writeAudit(tx, {
      action: AUDIT_ACTIONS.PENDING_UPDATE,
      module: AUDIT_MODULES.PENDIENTES,
      entity: "Pending",
      entityId: pending.id,
      before: {
        inventoryReadyQuantity: pending.inventoryReadyQuantity,
        reservedInventoryQuantity: pending.reservedInventoryQuantity,
        availabilityStatus: pending.availabilityStatus,
      },
      after: {
        inventoryReadyQuantity: keep,
        reservedInventoryQuantity: keep,
        availabilityStatus,
        reason: input.reason,
        physicalStock,
      },
      context: { userId: input.actorId },
    });

    clampedPendingIds.push(pending.id);
  }

  return {
    productId: input.productId,
    physicalStock,
    clampedPendingIds,
  };
}

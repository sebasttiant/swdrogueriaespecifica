import { createHash } from "node:crypto";

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@/lib/generated/prisma/client";
import { reconcilePendingClaimsForProduct } from "@/server/services/pending-claim-reconcile.service";
import {
  recordAuditInTransaction,
  type TransactionalAuditWriter,
} from "@/server/services/transactional-audit.service";

// --------------------------------------------------------------------------
// One-time repair for #332: bring legacy data to the physical-total invariant.
//
// Before the fix, a reception that allocated units to a pending subtracted
// them from `product_batches.quantity` although they stayed on the shelf, and
// registration promised stock without writing reservation rows. The runtime no
// longer does either; this repair converts what the old code left behind:
//
//   1. every live reservation proven to come from a reception (its inventory
//      allocation was written in the same transaction) is added back to the
//      batch it points to;
//   2. the promises of every affected product are rebuilt against the
//      corrected physical stock, oldest pending first. What the shelf cannot
//      back is clamped and becomes a missing item instead of a false "ready".
//
// It fails closed: a reservation without reception evidence, one owned by a
// terminal pending, one on another product's batch, or a batch physically
// adjusted after the reservation, blocks the whole repair. Those cases need a
// person, not a rule.
//
// Dry-run executes the full repair inside a transaction and rolls it back, so
// its fingerprint describes exactly what apply would write. Apply requires
// that fingerprint and records a marker command; any later run is a noop.
// --------------------------------------------------------------------------

export const INVENTORY_INVARIANT_REPAIR_COMMAND = "inventory.invariant.repair.v1";
const RECEPTION_EVIDENCE_WINDOW_SECONDS = 5;
const TERMINAL = ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"];

export type InventoryInvariantRestore = {
  reservationId: string;
  pendingId: string;
  batchId: string;
  productId: string;
  quantity: number;
};

export type InventoryInvariantClaim = {
  pendingId: string;
  productId: string;
  readyBefore: number;
  readyAfter: number;
  reservedBefore: number;
  reservedAfter: number;
  availabilityAfter: string;
};

export type InventoryInvariantRepairReport = {
  status: "planned" | "applied" | "noop" | "blocked";
  fingerprint: string;
  restores: InventoryInvariantRestore[];
  claims: InventoryInvariantClaim[];
  blockers: string[];
};

export type InventoryInvariantRepairInput = {
  actorId: string;
  apply: boolean;
  expectedFingerprint?: string;
};

class DryRunRollback extends Error {
  constructor(readonly report: InventoryInvariantRepairReport) {
    super("dry-run rollback");
  }
}

type LiveReservation = {
  id: string;
  pendingId: string;
  batchId: string;
  quantity: number;
  createdAt: Date;
  pendingProductId: string;
  batchProductId: string;
  pendingStatus: string;
  hasReceptionEvidence: boolean;
  adjustedAfter: boolean;
};

function fingerprintOf(
  restores: InventoryInvariantRestore[],
  claims: InventoryInvariantClaim[],
): string {
  const canonical = JSON.stringify({
    restores: [...restores].sort((a, b) => a.reservationId.localeCompare(b.reservationId)),
    claims: [...claims].sort((a, b) => a.pendingId.localeCompare(b.pendingId)),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function empty(status: InventoryInvariantRepairReport["status"], blockers: string[] = []) {
  return { status, fingerprint: fingerprintOf([], []), restores: [], claims: [], blockers };
}

async function readLiveReservations(tx: Prisma.TransactionClient): Promise<LiveReservation[]> {
  return tx.$queryRaw<LiveReservation[]>`
    SELECT pir.id,
           pir."pendingId",
           pir."batchId",
           pir.quantity,
           pir."createdAt",
           p."productId" AS "pendingProductId",
           pb."productId" AS "batchProductId",
           p.status::text AS "pendingStatus",
           EXISTS (
             SELECT 1 FROM inventory_allocations ia
             WHERE ia."pendingId" = pir."pendingId"
               AND abs(extract(epoch FROM ia."createdAt" - pir."createdAt"))
                   < ${RECEPTION_EVIDENCE_WINDOW_SECONDS}
           ) AS "hasReceptionEvidence",
           EXISTS (
             SELECT 1 FROM audit_logs al
             WHERE al.action = ${AUDIT_ACTIONS.INVENTORY_ADJUST}
               AND al."entityId" = pir."batchId"
               AND al."createdAt" > pir."createdAt"
           ) AS "adjustedAfter"
    FROM pending_inventory_reservations pir
    JOIN pendings p ON p.id = pir."pendingId"
    JOIN product_batches pb ON pb.id = pir."batchId"
    ORDER BY pir.id
  `;
}

function blockersOf(rows: LiveReservation[]): string[] {
  const blockers: string[] = [];
  for (const row of rows) {
    if (TERMINAL.includes(row.pendingStatus)) {
      blockers.push(`Reserva ${row.id} pertenece al pendiente terminado ${row.pendingId}.`);
    } else if (row.pendingProductId !== row.batchProductId) {
      blockers.push(`Reserva ${row.id} del pendiente ${row.pendingId} apunta a un lote de otro producto.`);
    } else if (!row.hasReceptionEvidence) {
      blockers.push(`Reserva ${row.id} del pendiente ${row.pendingId} no tiene evidencia de recepción.`);
    } else if (row.adjustedAfter) {
      blockers.push(`El lote ${row.batchId} tuvo un ajuste físico posterior a la reserva ${row.id}.`);
    }
  }
  return blockers;
}

/** Products whose open promises are not exactly their live reservations. */
async function productsWithUncoveredClaims(tx: Prisma.TransactionClient): Promise<string[]> {
  const rows = await tx.$queryRaw<{ productId: string }[]>`
    SELECT DISTINCT p."productId"
    FROM pendings p
    LEFT JOIN (
      SELECT "pendingId", SUM(quantity)::int AS live
      FROM pending_inventory_reservations GROUP BY 1
    ) r ON r."pendingId" = p.id
    WHERE p.status NOT IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL')
      AND (p."inventoryReadyQuantity" - p."deliveredQuantity" <> COALESCE(r.live, 0)
           OR p."reservedInventoryQuantity" <> COALESCE(r.live, 0))
    ORDER BY 1
  `;
  return rows.map((row) => row.productId);
}

async function lockProducts(tx: Prisma.TransactionClient, productIds: string[]) {
  if (productIds.length === 0) return;
  // Global lock order: products → batches → pendings, the same order reception
  // and delivery use, so the repair cannot deadlock with live operations.
  await tx.$queryRaw`SELECT id FROM products WHERE id = ANY(${productIds}::text[]) ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM product_batches WHERE "productId" = ANY(${productIds}::text[]) ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM pendings WHERE "productId" = ANY(${productIds}::text[]) ORDER BY id FOR UPDATE`;
}

function openPendingsOf(tx: Prisma.TransactionClient, productIds: string[]) {
  return tx.pending.findMany({
    where: { productId: { in: productIds }, status: { notIn: ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"] } },
    select: { id: true, productId: true, inventoryReadyQuantity: true, reservedInventoryQuantity: true, availabilityStatus: true },
  });
}

async function runRepair(
  tx: Prisma.TransactionClient,
  input: InventoryInvariantRepairInput,
  writeAudit: TransactionalAuditWriter,
): Promise<InventoryInvariantRepairReport> {
  // Serializes concurrent runs; the marker below makes later runs noops.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${INVENTORY_INVARIANT_REPAIR_COMMAND}))`;
  const done = await tx.operationalCommand.findFirst({
    where: { commandType: INVENTORY_INVARIANT_REPAIR_COMMAND },
  });
  if (done) return empty("noop");

  const candidates = new Set<string>(await productsWithUncoveredClaims(tx));
  for (const row of await readLiveReservations(tx)) candidates.add(row.batchProductId);
  const productIds = [...candidates].sort((a, b) => a.localeCompare(b));
  await lockProducts(tx, productIds);

  // Re-read under the locks: this is the state the repair acts on.
  const live = await readLiveReservations(tx);
  const blockers = blockersOf(live);
  if (blockers.length > 0) return empty("blocked", blockers);

  const restores: InventoryInvariantRestore[] = live.map((row) => ({
    reservationId: row.id,
    pendingId: row.pendingId,
    batchId: row.batchId,
    productId: row.batchProductId,
    quantity: row.quantity,
  }));

  const byBatch = new Map<string, number>();
  for (const restore of restores) {
    byBatch.set(restore.batchId, (byBatch.get(restore.batchId) ?? 0) + restore.quantity);
  }
  for (const [batchId, restoredUnits] of [...byBatch].sort(([a], [b]) => a.localeCompare(b))) {
    const before = await tx.productBatch.findUniqueOrThrow({ where: { id: batchId }, select: { quantity: true } });
    const after = await tx.productBatch.update({
      where: { id: batchId },
      data: { quantity: { increment: restoredUnits } },
      select: { quantity: true },
    });
    await writeAudit(tx, {
      action: AUDIT_ACTIONS.INVENTORY_INVARIANT_RESTORE,
      module: AUDIT_MODULES.ENTRADAS,
      entity: "ProductBatch",
      entityId: batchId,
      before: { quantity: before.quantity },
      after: { quantity: after.quantity, restoredUnits, issue: 332 },
      context: { userId: input.actorId },
    });
  }

  const pendingsBefore = await openPendingsOf(tx, productIds);
  for (const productId of productIds) {
    await reconcilePendingClaimsForProduct(tx, {
      productId,
      actorId: input.actorId,
      writeAudit,
      reason: "Issue #332: rebuild reservations against the physical total",
    });
  }
  const after = new Map((await openPendingsOf(tx, productIds)).map((row) => [row.id, row]));
  const claims: InventoryInvariantClaim[] = [];
  for (const row of pendingsBefore) {
    const now = after.get(row.id);
    if (!now) continue;
    if (
      now.inventoryReadyQuantity === row.inventoryReadyQuantity &&
      now.reservedInventoryQuantity === row.reservedInventoryQuantity &&
      now.availabilityStatus === row.availabilityStatus
    ) {
      continue;
    }
    claims.push({
      pendingId: row.id,
      productId: row.productId,
      readyBefore: row.inventoryReadyQuantity,
      readyAfter: now.inventoryReadyQuantity,
      reservedBefore: row.reservedInventoryQuantity,
      reservedAfter: now.reservedInventoryQuantity,
      availabilityAfter: now.availabilityStatus,
    });
  }

  const fingerprint = fingerprintOf(restores, claims);
  const report: InventoryInvariantRepairReport = {
    status: input.apply ? "applied" : "planned",
    fingerprint,
    restores,
    claims,
    blockers: [],
  };
  if (!input.apply) throw new DryRunRollback(report);
  if (input.expectedFingerprint !== fingerprint) {
    throw new DryRunRollback({
      ...report,
      status: "blocked",
      blockers: [
        input.expectedFingerprint
          ? "La huella no coincide con la simulación revisada: la base cambió. Volvé a simular."
          : "Aplicar exige la huella de la simulación revisada.",
      ],
    });
  }

  await tx.operationalCommand.create({
    data: {
      actorId: input.actorId,
      commandType: INVENTORY_INVARIANT_REPAIR_COMMAND,
      commandKey: "issue-332",
      fingerprint,
      result: { restoredUnits: restores.reduce((t, r) => t + r.quantity, 0), claims: claims.length },
    },
  });
  return report;
}

export async function repairInventoryInvariant(
  input: InventoryInvariantRepairInput,
  deps: { writeAudit?: TransactionalAuditWriter } = {},
): Promise<InventoryInvariantRepairReport> {
  const writeAudit = deps.writeAudit ?? recordAuditInTransaction;
  try {
    return await prisma.$transaction((tx) => runRepair(tx, input, writeAudit), {
      timeout: 120_000,
      maxWait: 10_000,
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.report;
    throw error;
  }
}

export function formatInventoryInvariantReport(report: InventoryInvariantRepairReport): string {
  const lines = [`Estado: ${report.status}`];
  if (report.status === "noop") {
    lines.push("La reparación ya fue aplicada; no se escribió nada.");
    return lines.join("\n");
  }
  for (const blocker of report.blockers) lines.push(`BLOQUEO: ${blocker}`);
  if (report.status === "blocked" && report.restores.length === 0) return lines.join("\n");
  lines.push(`Unidades devueltas a lotes: ${report.restores.reduce((t, r) => t + r.quantity, 0)}`);
  for (const r of report.restores) {
    lines.push(`  + ${r.quantity} al lote ${r.batchId} (pendiente ${r.pendingId})`);
  }
  lines.push(`Pendientes reconciliados: ${report.claims.length}`);
  for (const c of report.claims) {
    lines.push(
      `  ${c.pendingId}: listo ${c.readyBefore}→${c.readyAfter}, reservado ${c.reservedBefore}→${c.reservedAfter}, ${c.availabilityAfter}`,
    );
  }
  lines.push(`Huella: ${report.fingerprint}`);
  return lines.join("\n");
}

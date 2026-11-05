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

/**
 * An open pending with unsourced demand and no missing item. Listed for a
 * person, never fixed automatically: management may have discarded that need
 * on purpose, and recreating it would make purchasing buy what nobody wants.
 */
export type InventoryInvariantOrphan = {
  pendingId: string;
  productId: string;
  deficit: number;
};

/**
 * Units legacy reception subtracted from a batch whose reservation an old
 * release (cancel, partial close, product change, rebuild) later deleted
 * without returning them. No row says which batch they came from, so they are
 * reported for a physical count instead of being added back by guess.
 */
export type InventoryInvariantLostUnits = {
  productId: string;
  productName: string;
  units: number;
};

export type InventoryInvariantRepairReport = {
  status: "planned" | "applied" | "noop" | "blocked";
  fingerprint: string;
  restores: InventoryInvariantRestore[];
  claims: InventoryInvariantClaim[];
  orphans: InventoryInvariantOrphan[];
  lostUnits: InventoryInvariantLostUnits[];
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
  /** Written before the deploy cutover, i.e. by the old code. */
  legacy: boolean;
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function empty(status: InventoryInvariantRepairReport["status"], blockers: string[] = []) {
  return {
    status,
    fingerprint: hash({ status, blockers }),
    restores: [],
    claims: [],
    orphans: [],
    lostUnits: [],
    blockers,
  };
}

async function readCutover(tx: Prisma.TransactionClient): Promise<Date | null> {
  const row = await tx.inventoryInvariantCutover.findUnique({ where: { id: 1 } });
  return row?.cutoverAt ?? null;
}

async function readLiveReservations(
  tx: Prisma.TransactionClient,
  cutoverAt: Date,
): Promise<LiveReservation[]> {
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
           ) AS "adjustedAfter",
           pir."createdAt" < ${cutoverAt} AS legacy
    FROM pending_inventory_reservations pir
    JOIN pendings p ON p.id = pir."pendingId"
    JOIN product_batches pb ON pb.id = pir."batchId"
    ORDER BY pir.id
  `;
}

/**
 * Only legacy rows are judged. A row written after the cutover follows the new
 * rules by construction: it never subtracted the batch, so there is nothing to
 * restore and nothing to doubt.
 */
function blockersOf(rows: LiveReservation[]): string[] {
  const blockers: string[] = [];
  for (const row of rows) {
    if (!row.legacy) continue;
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

async function readOrphans(tx: Prisma.TransactionClient): Promise<InventoryInvariantOrphan[]> {
  return tx.$queryRaw<InventoryInvariantOrphan[]>`
    SELECT p.id AS "pendingId",
           p."productId",
           (p.quantity - p."inventoryReadyQuantity")::int AS deficit
    FROM pendings p
    WHERE p.status NOT IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL')
      AND p.quantity - p."inventoryReadyQuantity" > 0
      AND NOT EXISTS (
        SELECT 1 FROM missing_items m
        WHERE m."originId" = p.id
          AND (m.status IN ('FALTANTE', 'PEDIDO', 'EN_BODEGA') OR m."discardedAt" IS NOT NULL)
      )
    ORDER BY p.id
  `;
}

async function readLostUnits(
  tx: Prisma.TransactionClient,
  cutoverAt: Date,
): Promise<InventoryInvariantLostUnits[]> {
  return tx.$queryRaw<InventoryInvariantLostUnits[]>`
    WITH allocated AS (
      SELECT ia."pendingId", mi."productId", SUM(ia.quantity)::int AS units
      FROM inventory_allocations ia
      JOIN missing_items mi ON mi.id = ia."missingItemId"
      WHERE ia."pendingId" IS NOT NULL AND ia."createdAt" < ${cutoverAt}
      GROUP BY 1, 2
    ), live AS (
      SELECT "pendingId", SUM(quantity)::int AS units
      FROM pending_inventory_reservations
      WHERE "createdAt" < ${cutoverAt}
      GROUP BY 1
    ), lost AS (
      SELECT a."productId",
             GREATEST(a.units - p."deliveredQuantity" - COALESCE(l.units, 0), 0) AS units
      FROM allocated a
      JOIN pendings p ON p.id = a."pendingId"
      LEFT JOIN live l ON l."pendingId" = a."pendingId"
    )
    SELECT lost."productId", pr.name AS "productName", SUM(lost.units)::int AS units
    FROM lost JOIN products pr ON pr.id = lost."productId"
    GROUP BY lost."productId", pr.name
    HAVING SUM(lost.units) > 0
    ORDER BY lost."productId"
  `;
}

/**
 * The full state the repair leaves on the affected products, without generated
 * ids or timestamps. Hashing it means apply writes exactly what the reviewed
 * dry-run showed: any drift (a new lot, a delivery, a different spread across
 * batches) changes the fingerprint and apply refuses.
 */
async function postState(tx: Prisma.TransactionClient, productIds: string[]) {
  const [batches, reservations, pendings, missing] = await Promise.all([
    tx.productBatch.findMany({
      where: { productId: { in: productIds } },
      select: { id: true, quantity: true },
      orderBy: { id: "asc" },
    }),
    tx.pendingInventoryReservation.findMany({
      where: { batch: { productId: { in: productIds } } },
      select: { pendingId: true, batchId: true, quantity: true },
      orderBy: [{ pendingId: "asc" }, { batchId: "asc" }],
    }),
    tx.pending.findMany({
      where: { productId: { in: productIds }, status: { notIn: ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"] } },
      select: { id: true, inventoryReadyQuantity: true, reservedInventoryQuantity: true, availabilityStatus: true },
      orderBy: { id: "asc" },
    }),
    tx.missingItem.findMany({
      where: {
        productId: { in: productIds },
        originId: { not: null },
        status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] },
      },
      select: { originId: true, productId: true, quantity: true, receivedQuantity: true, status: true },
      orderBy: [{ originId: "asc" }, { productId: "asc" }, { quantity: "asc" }],
    }),
  ]);
  return { batches, reservations, pendings, missing };
}

async function lockProducts(tx: Prisma.TransactionClient, productIds: string[]) {
  if (productIds.length === 0) return;
  // Global lock order: products → batches → pendings. Batches use the same
  // total order as every other batch lock, so the repair cannot deadlock with
  // live operations.
  await tx.$queryRaw`SELECT id FROM products WHERE id = ANY(${productIds}::text[]) ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM product_batches WHERE "productId" = ANY(${productIds}::text[]) ORDER BY "expiresAt" ASC NULLS LAST, id ASC FOR UPDATE`;
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

  const cutoverAt = await readCutover(tx);
  if (!cutoverAt) {
    return empty("blocked", [
      "Falta la marca de corte del deploy (inventory_invariant_cutover). Sin ella no se puede distinguir lo que escribió el código viejo.",
    ]);
  }

  const candidates = new Set<string>(await productsWithUncoveredClaims(tx));
  for (const row of await readLiveReservations(tx, cutoverAt)) {
    if (row.legacy) candidates.add(row.batchProductId);
  }
  const productIds = [...candidates].sort((a, b) => a.localeCompare(b));
  await lockProducts(tx, productIds);

  // Re-read under the locks: this is the state the repair acts on.
  const live = await readLiveReservations(tx, cutoverAt);
  const blockers = blockersOf(live);
  if (blockers.length > 0) return empty("blocked", blockers);
  const lostUnits = await readLostUnits(tx, cutoverAt);

  const restores: InventoryInvariantRestore[] = live.filter((row) => row.legacy).map((row) => ({
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

  const orphans = await readOrphans(tx);
  const fingerprint = hash({
    restores: [...restores].sort((a, b) => a.reservationId.localeCompare(b.reservationId)),
    lostUnits,
    orphans,
    state: await postState(tx, productIds),
  });
  const report: InventoryInvariantRepairReport = {
    status: input.apply ? "applied" : "planned",
    fingerprint,
    restores,
    claims,
    orphans,
    lostUnits,
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
  lines.push(`Unidades posiblemente perdidas por liberaciones antiguas (requieren conteo físico): ${report.lostUnits.reduce((t, l) => t + l.units, 0)}`);
  for (const l of report.lostUnits) {
    lines.push(`  ${l.units} de ${l.productName} (${l.productId})`);
  }
  lines.push(`Pendientes sin faltante (revisar a mano, no se tocan): ${report.orphans.length}`);
  for (const o of report.orphans) {
    lines.push(`  ${o.pendingId}: faltan ${o.deficit} del producto ${o.productId}`);
  }
  lines.push(`Huella: ${report.fingerprint}`);
  return lines.join("\n");
}

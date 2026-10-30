// --------------------------------------------------------------------------
// Audited repair of duplicated product identity (October 2026 incident).
//
// This is the only sanctioned way to fix the rows the incident left behind.
// There is no hand-written UPDATE, and that is the point: a manual statement
// has no drift guard, no plan to review, no transaction boundary and no audit
// trail, so nobody can tell afterwards what it did or whether the database
// still looked the way it did when the change was approved.
//
// Five properties hold the whole design together:
//
//   DRY-RUN BY DEFAULT. `apply` must be exactly `true`. Anything else — absent,
//   undefined, the string "false" — plans and writes nothing.
//
//   GUARDS RUN INSIDE THE TRANSACTION, UNDER LOCK. Every row the repair will
//   touch is read with `SELECT … FOR UPDATE` in the same transaction that
//   writes it, and every write is a conditional `updateMany` that must affect
//   exactly one row. A read outside the transaction is only a preview: between
//   that read and the write, somebody at the counter can receive merchandise,
//   deliver the pending or relink the code, and an unconditional update would
//   then produce a WRONG result with an audit entry describing a state that
//   never existed. Guarded this way, a concurrent change makes the repair FAIL
//   instead of lie.
//
//   DRIFT REFUSES. The manifest states what the operator reviewed. If the
//   database no longer matches it — the code moved, a duplicate grew stock, a
//   pending now belongs to someone else or is already closed, a duplicate has
//   open rows nobody listed — the repair stops with reasons instead of
//   guessing. Repairing a database you no longer recognise is how an incident
//   becomes two incidents.
//
//   NOTHING IS DELETED. Duplicates are deactivated and kept for review. The
//   history of what the operators actually did stays queryable.
//
//   FULLY AUDITED. Every write and its audit entry share a transaction, so the
//   repair either lands completely with its trail or does not land at all.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { normalizeOrionCode } from "@/server/domain/catalog/sku-identity";
import { MANAGEMENT_STATUSES } from "@/features/pendientes/management-status";
import {
  recordAuditInTransaction,
  type TransactionalAuditWriter,
} from "@/server/services/transactional-audit.service";
import type { Prisma } from "@/lib/generated/prisma/client";

/**
 * Pending states that are still live work. A closed pending is HISTORY:
 * reassigning it would rewrite what the droguería actually did.
 *
 * The management statuses belong here, derived from their own canonical list:
 * they are NOT terminal, and the fulfillment-lifecycle migration copied them
 * into `purchaseStatus` without clearing `status`, so historical rows still
 * carry them. Omitting one would let the repair deactivate a duplicate while
 * its live pending stayed attached to a product nobody can see — exactly the
 * dead end the incident created — and would reject that same pending as
 * closed when the operator did list it.
 */
const OPEN_PENDING_STATUSES = ["PENDIENTE", "PARCIAL", ...MANAGEMENT_STATUSES] as const;
/** Missing-item states that are still live work, for the same reason. */
const OPEN_MISSING_STATUSES = ["FALTANTE", "PEDIDO", "EN_BODEGA"] as const;

export type ProductIdentityRepairManifest = {
  /** Who runs the repair. Every audit entry carries it. */
  actorId: string;
  /** The product that survives: the one holding the stock and the lot. */
  targetProductId: string;
  /** The code the target has RIGHT NOW, as reviewed. Drift guard. */
  expectedTargetOrionCode: string | null;
  /** The exact code Orion shows for this product. */
  canonicalOrionCode: string;
  /** Products created by mistake. Deactivated, never deleted. */
  duplicateProductIds: string[];
  /** Open pendings to move onto the target. */
  pendingIds: string[];
  /** Open missing items to move onto the target. */
  missingItemIds: string[];
  /** Nothing is written unless this is exactly `true`. */
  apply?: boolean;
};

export type ProductIdentityRepairPlan = {
  orionCode: { from: string | null; to: string } | null;
  reassignedPendings: string[];
  reassignedMissingItems: string[];
  deactivatedProducts: string[];
};

export type ProductIdentityRepairReport = {
  /**
   * `planned` — a dry run with work to do.
   * `applied` — the work was written.
   * `noop`    — the database already looks like the desired outcome.
   * `blocked` — the database does not match the manifest; nothing was written.
   */
  status: "planned" | "applied" | "noop" | "blocked";
  applied: boolean;
  plan: ProductIdentityRepairPlan;
  blockers: string[];
};

const EMPTY_PLAN: ProductIdentityRepairPlan = {
  orionCode: null,
  reassignedPendings: [],
  reassignedMissingItems: [],
  deactivatedProducts: [],
};

/**
 * A row the repair is about to touch, as PostgreSQL has it right now. Read with
 * `FOR UPDATE` so no concurrent transaction can move it underneath us.
 */
type LockedProduct = {
  id: string;
  name: string;
  orionCode: string | null;
  active: boolean;
  identityVersion: number;
  catalogVersion: number;
  needsReview: boolean;
};
type LockedChild = { id: string; productId: string; status: string };

/**
 * Either the reasons the repair refuses, or the plan built from locked rows.
 * Discriminated on `ok` so a caller cannot read the plan of a blocked
 * assessment: that would not compile.
 */
type RepairAssessment =
  | { ok: false; blockers: string[] }
  | {
      ok: true;
      plan: ProductIdentityRepairPlan;
      target: LockedProduct;
      duplicates: LockedProduct[];
      pendings: LockedChild[];
      missingItems: LockedChild[];
    };

/** Raised when a conditional write matches no row: somebody got there first. */
class RepairConcurrencyError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "RepairConcurrencyError";
  }
}

export async function repairProductIdentity(
  manifest: ProductIdentityRepairManifest,
  deps: { writeAudit?: TransactionalAuditWriter } = {},
): Promise<ProductIdentityRepairReport> {
  const writeAudit = deps.writeAudit ?? recordAuditInTransaction;
  const canonicalCode = normalizeOrionCode(manifest.canonicalOrionCode);
  // Exactly `true`, never merely truthy: `apply: "false"` from a hand-written
  // manifest must not write to a pharmacy's database.
  const apply = manifest.apply === true;

  // Everything — guards, plan and writes — happens inside ONE transaction, so
  // the state the plan was computed from is the state that gets written. The
  // dry run rolls back deliberately instead of committing nothing, which keeps
  // the two paths reading the exact same locked rows.
  try {
    return await prisma.$transaction(async (tx) => {
      const assessment = await assess(tx, manifest, canonicalCode);
      if (!assessment.ok) return blocked(assessment.blockers);

      const { plan, target, duplicates, pendings, missingItems } = assessment;
      const hasWork =
        plan.orionCode !== null ||
        plan.reassignedPendings.length > 0 ||
        plan.reassignedMissingItems.length > 0 ||
        plan.deactivatedProducts.length > 0;

      if (!apply) {
        return { status: hasWork ? "planned" : "noop", applied: false, plan, blockers: [] };
      }
      if (!hasWork) {
        return { status: "noop", applied: false, plan, blockers: [] };
      }

      const context = { userId: manifest.actorId };

      if (plan.orionCode) {
        // Compare-and-set on `identityVersion`, the same witness the ordinary
        // Orion-link flow uses. If anybody relinked this product since the
        // locked read, this matches zero rows and the repair aborts.
        const linked = await tx.product.updateMany({
          where: { id: target.id, identityVersion: target.identityVersion },
          data: { orionCode: plan.orionCode.to, identityVersion: { increment: 1 } },
        });
        if (linked.count !== 1) {
          throw new RepairConcurrencyError(
            `El producto ${target.id} cambió su identidad durante la reparación.`,
          );
        }
        await writeAudit(tx, {
          // A relink, not a first link: the product already had a code.
          action: AUDIT_ACTIONS.SKU_ORION_RELINK,
          module: AUDIT_MODULES.PRODUCTOS,
          entity: "Product",
          entityId: target.id,
          before: { orionCode: plan.orionCode.from, identityVersion: target.identityVersion },
          after: { orionCode: plan.orionCode.to, identityVersion: target.identityVersion + 1 },
          context,
        });
      }

      for (const pendingId of plan.reassignedPendings) {
        const before = pendings.find((pending) => pending.id === pendingId);
        if (!before) continue;
        const moved = await tx.pending.updateMany({
          // The productId AND the status are part of the condition: a pending
          // delivered or cancelled after the locked read must not be moved.
          where: { id: pendingId, productId: before.productId, status: before.status as never },
          data: { productId: target.id },
        });
        if (moved.count !== 1) {
          throw new RepairConcurrencyError(
            `El pendiente ${pendingId} cambió durante la reparación.`,
          );
        }
        await writeAudit(tx, {
          action: AUDIT_ACTIONS.PENDING_UPDATE,
          module: AUDIT_MODULES.PRODUCTOS,
          entity: "Pending",
          entityId: pendingId,
          before: { productId: before.productId, status: before.status },
          after: { productId: target.id, status: before.status },
          context,
        });
      }

      for (const missingItemId of plan.reassignedMissingItems) {
        const before = missingItems.find((missingItem) => missingItem.id === missingItemId);
        if (!before) continue;
        const moved = await tx.missingItem.updateMany({
          where: {
            id: missingItemId,
            productId: before.productId,
            status: before.status as never,
          },
          data: { productId: target.id },
        });
        if (moved.count !== 1) {
          throw new RepairConcurrencyError(
            `El faltante ${missingItemId} cambió durante la reparación.`,
          );
        }
        await writeAudit(tx, {
          action: AUDIT_ACTIONS.MISSING_STATUS_CHANGE,
          module: AUDIT_MODULES.PRODUCTOS,
          entity: "MissingItem",
          entityId: missingItemId,
          before: { productId: before.productId, status: before.status },
          after: { productId: target.id, status: before.status },
          context,
        });
      }

      for (const duplicateId of plan.deactivatedProducts) {
        // The locked read is the prior state: auditing a placeholder would
        // describe a row that never existed and void the audited guarantee.
        const before = duplicates.find((duplicate) => duplicate.id === duplicateId);
        if (!before) {
          throw new RepairConcurrencyError(
            `El duplicado ${duplicateId} no quedó bloqueado por la evaluación.`,
          );
        }
        // Deactivated and still flagged for review: somebody has to look at it,
        // and a deleted row cannot be looked at.
        //
        // `catalogVersion` advances too. The row lock only covers THIS
        // transaction: a catalog-edit form opened before the repair would
        // otherwise still match afterwards and silently reactivate the
        // duplicate through its stale `active` field. Advancing the version
        // makes the existing optimistic-concurrency check reject that edit.
        const deactivated = await tx.product.updateMany({
          where: { id: duplicateId, active: true, catalogVersion: before.catalogVersion },
          data: { active: false, needsReview: true, catalogVersion: { increment: 1 } },
        });
        if (deactivated.count !== 1) {
          throw new RepairConcurrencyError(
            `El duplicado ${duplicateId} cambió durante la reparación.`,
          );
        }
        await writeAudit(tx, {
          action: AUDIT_ACTIONS.PRODUCT_UPDATE,
          module: AUDIT_MODULES.PRODUCTOS,
          entity: "Product",
          entityId: duplicateId,
          before: {
            active: true,
            needsReview: before.needsReview,
            catalogVersion: before.catalogVersion,
          },
          after: {
            active: false,
            needsReview: true,
            catalogVersion: before.catalogVersion + 1,
            replacedByProductId: target.id,
          },
          context,
        });
      }

      return { status: "applied", applied: true, plan, blockers: [] };
    });
  } catch (error) {
    if (error instanceof RepairConcurrencyError) {
      return blocked([
        error.message,
        "No se escribió nada: la transacción se revirtió completa.",
      ]);
    }
    throw error;
  }
}

/**
 * Reads, under lock, everything the repair needs to decide, and builds the
 * plan from those exact rows.
 */
async function assess(
  tx: Prisma.TransactionClient,
  manifest: ProductIdentityRepairManifest,
  canonicalCode: string,
): Promise<RepairAssessment> {
  const blockers: string[] = [];

  // Locking the target and the duplicates in ONE statement, ordered by id,
  // keeps two concurrent repairs from deadlocking each other.
  const lockedProducts = await lockProducts(tx, [
    manifest.targetProductId,
    ...manifest.duplicateProductIds,
  ]);

  const target = lockedProducts.find((row) => row.id === manifest.targetProductId);
  if (!target) {
    return {
      ok: false,
      blockers: [`El producto objetivo ${manifest.targetProductId} no existe.`],
    };
  }

  // Drift guard #1 — the identity the operator reviewed. Already-canonical is
  // not drift: it is the idempotent replay of a repair that already ran.
  if (
    target.orionCode !== manifest.expectedTargetOrionCode &&
    target.orionCode !== canonicalCode
  ) {
    blockers.push(
      `El orionCode del objetivo cambió: el manifiesto esperaba ` +
        `"${manifest.expectedTargetOrionCode}" y la base tiene "${target.orionCode}".`,
    );
  }

  // Drift guard #2 — the canonical code must be free or already the target's.
  const codeHolder = await tx.product.findUnique({
    where: { orionCode: canonicalCode },
    select: { id: true, name: true },
  });
  if (codeHolder && codeHolder.id !== target.id) {
    blockers.push(
      `El código ${canonicalCode} ya pertenece a "${codeHolder.name}" (${codeHolder.id}).`,
    );
  }

  const duplicates = lockedProducts.filter((row) => row.id !== target.id);
  for (const id of manifest.duplicateProductIds) {
    if (!lockedProducts.some((row) => row.id === id)) {
      blockers.push(`El duplicado ${id} no existe.`);
    }
  }
  if (manifest.duplicateProductIds.includes(target.id)) {
    blockers.push("El objetivo no puede figurar también como duplicado.");
  }

  const listedPendingIds = new Set(manifest.pendingIds);
  const listedMissingIds = new Set(manifest.missingItemIds);

  // Drift guard #3 — a duplicate holding merchandise is NOT a duplicate anybody
  // can deactivate from here. Somebody received stock against it, and that is a
  // catalog decision, not a repair. BOTH inventory models are checked: the
  // legacy `product_batches` and the canonical `lots`. Checking only one would
  // hide stock in whichever model the cutover happens to be using.
  for (const duplicate of duplicates) {
    const [legacyStock, canonicalStock, entries, movements, reservations] = await Promise.all([
      tx.productBatch.aggregate({
        where: { productId: duplicate.id },
        _sum: { quantity: true },
      }),
      tx.lot.aggregate({ where: { productId: duplicate.id }, _sum: { onHand: true } }),
      tx.inventoryEntry.count({ where: { productId: duplicate.id } }),
      tx.inventoryMovement.count({ where: { productId: duplicate.id } }),
      tx.pendingInventoryReservation.count({
        where: { batch: { productId: duplicate.id } },
      }),
    ]);

    if ((legacyStock._sum.quantity ?? 0) > 0) {
      blockers.push(
        `El duplicado ${duplicate.id} todavía tiene stock en lotes legados ` +
          `(${legacyStock._sum.quantity}).`,
      );
    }
    if ((canonicalStock._sum.onHand ?? 0) > 0) {
      blockers.push(
        `El duplicado ${duplicate.id} todavía tiene stock canónico ` +
          `(${canonicalStock._sum.onHand}).`,
      );
    }
    if (entries > 0) {
      blockers.push(`El duplicado ${duplicate.id} tiene ${entries} entradas de inventario.`);
    }
    if (movements > 0) {
      blockers.push(`El duplicado ${duplicate.id} tiene ${movements} movimientos de inventario.`);
    }
    if (reservations > 0) {
      blockers.push(`El duplicado ${duplicate.id} tiene ${reservations} reservas de stock.`);
    }
    if (duplicate.orionCode && duplicate.orionCode !== canonicalCode) {
      blockers.push(
        `El duplicado ${duplicate.id} tiene su propio código ${duplicate.orionCode}: ` +
          `desactivarlo escondería una identidad distinta.`,
      );
    }

    // Drift guard #4 — EXHAUSTIVENESS. Every live row of a duplicate has to be
    // in the manifest. A pending left out would stay attached to a product
    // nobody can see any more, which is the same dead end the incident created.
    const [openPendings, openMissingItems] = await Promise.all([
      tx.pending.findMany({
        where: { productId: duplicate.id, status: { in: OPEN_PENDING_STATUSES as never } },
        select: { id: true },
      }),
      tx.missingItem.findMany({
        where: { productId: duplicate.id, status: { in: OPEN_MISSING_STATUSES as never } },
        select: { id: true },
      }),
    ]);
    for (const pending of openPendings) {
      if (!listedPendingIds.has(pending.id)) {
        blockers.push(
          `El duplicado ${duplicate.id} tiene el pendiente abierto ${pending.id}, ` +
            `que el manifiesto no reasigna.`,
        );
      }
    }
    for (const missingItem of openMissingItems) {
      if (!listedMissingIds.has(missingItem.id)) {
        blockers.push(
          `El duplicado ${duplicate.id} tiene el faltante abierto ${missingItem.id}, ` +
            `que el manifiesto no reasigna.`,
        );
      }
    }
  }

  // Drift guard #5 — every listed row must belong to a listed duplicate (or
  // already be on the target), and must still be OPEN. A closed pending is
  // history; moving it would rewrite what actually happened.
  const ownedIds = new Set(duplicates.map((duplicate) => duplicate.id));

  const pendings = await lockPendings(tx, manifest.pendingIds);
  for (const id of manifest.pendingIds) {
    const pending = pendings.find((row) => row.id === id);
    if (!pending) {
      blockers.push(`El pendiente ${id} no existe.`);
      continue;
    }
    if (!ownedIds.has(pending.productId) && pending.productId !== target.id) {
      blockers.push(
        `El pendiente ${id} pertenece a ${pending.productId}, que no está en el manifiesto.`,
      );
    }
    if (!(OPEN_PENDING_STATUSES as readonly string[]).includes(pending.status)) {
      blockers.push(
        `El pendiente ${id} está ${pending.status}: reasignarlo reescribiría historia cerrada.`,
      );
    }
  }

  const missingItems = await lockMissingItems(tx, manifest.missingItemIds);
  for (const id of manifest.missingItemIds) {
    const missingItem = missingItems.find((row) => row.id === id);
    if (!missingItem) {
      blockers.push(`El faltante ${id} no existe.`);
      continue;
    }
    if (!ownedIds.has(missingItem.productId) && missingItem.productId !== target.id) {
      blockers.push(
        `El faltante ${id} pertenece a ${missingItem.productId}, que no está en el manifiesto.`,
      );
    }
    if (!(OPEN_MISSING_STATUSES as readonly string[]).includes(missingItem.status)) {
      blockers.push(
        `El faltante ${id} está ${missingItem.status}: reasignarlo reescribiría historia cerrada.`,
      );
    }
  }

  if (blockers.length > 0) return { ok: false, blockers };

  // Only what is still pending work enters the plan: a repair that already ran
  // produces an empty plan instead of rewriting rows that are already right.
  const plan: ProductIdentityRepairPlan = {
    orionCode:
      target.orionCode === canonicalCode
        ? null
        : { from: target.orionCode, to: canonicalCode },
    reassignedPendings: pendings
      .filter((pending) => pending.productId !== target.id)
      .map((pending) => pending.id),
    reassignedMissingItems: missingItems
      .filter((missingItem) => missingItem.productId !== target.id)
      .map((missingItem) => missingItem.id),
    deactivatedProducts: duplicates
      .filter((duplicate) => duplicate.active)
      .map((duplicate) => duplicate.id),
  };

  return { ok: true, plan, target, duplicates, pendings, missingItems };
}

// `FOR UPDATE` and not a plain read: under READ COMMITTED a plain read inside
// the transaction still sees a snapshot and locks nothing, so the row could
// change between the guard and the write. Ordered by id so two concurrent
// repairs queue instead of deadlocking.
function lockProducts(
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<LockedProduct[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return tx.$queryRaw<LockedProduct[]>`
    SELECT id, name, "orionCode", active, "identityVersion", "catalogVersion", "needsReview"
      FROM products
     WHERE id = ANY(${ids}::text[])
     ORDER BY id
       FOR UPDATE
  `;
}

function lockPendings(
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<LockedChild[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return tx.$queryRaw<LockedChild[]>`
    SELECT id, "productId", status::text AS status
      FROM pendings
     WHERE id = ANY(${ids}::text[])
     ORDER BY id
       FOR UPDATE
  `;
}

function lockMissingItems(
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<LockedChild[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return tx.$queryRaw<LockedChild[]>`
    SELECT id, "productId", status::text AS status
      FROM missing_items
     WHERE id = ANY(${ids}::text[])
     ORDER BY id
       FOR UPDATE
  `;
}

function blocked(blockers: string[]): ProductIdentityRepairReport {
  return { status: "blocked", applied: false, plan: EMPTY_PLAN, blockers };
}

/**
 * The reviewable form of the plan.
 *
 * Every id is printed, never just a count: the runbook asks the operator to
 * confirm that what production is about to do is IDENTICAL to what was
 * validated against the restored copy, and a count of three cannot be compared
 * against another count of three.
 */
export function formatRepairReport(
  report: ProductIdentityRepairReport,
  options: { applyRequested?: boolean } = {},
): string {
  const lines: string[] = [`Estado: ${report.status}`];

  if (report.blockers.length > 0) {
    lines.push("", "Bloqueos (no se escribió nada):");
    for (const blocker of report.blockers) lines.push(`  - ${blocker}`);
    return lines.join("\n");
  }

  lines.push(
    "",
    report.plan.orionCode
      ? `orionCode: ${report.plan.orionCode.from} -> ${report.plan.orionCode.to}`
      : "orionCode: sin cambios",
    `pendientes a reasignar (${report.plan.reassignedPendings.length}):`,
    ...idLines(report.plan.reassignedPendings),
    `faltantes a reasignar (${report.plan.reassignedMissingItems.length}):`,
    ...idLines(report.plan.reassignedMissingItems),
    `productos a desactivar (${report.plan.deactivatedProducts.length}):`,
    ...idLines(report.plan.deactivatedProducts),
  );

  if (report.status === "planned") {
    lines.push("", "Dry-run: no se escribió nada. Usá --apply para ejecutar.");
  } else if (report.status === "blocked") {
    lines.push("", "Bloqueado: no se escribió nada.");
  } else if (report.status === "noop") {
    lines.push(
      "",
      options.applyRequested
        ? "No había cambios pendientes; no se escribió nada."
        : "Dry-run: la base ya coincide con el resultado esperado; no se escribió nada.",
    );
  }

  return lines.join("\n");
}

function idLines(ids: string[]): string[] {
  return ids.length === 0 ? ["  (ninguno)"] : ids.map((id) => `  - ${id}`);
}

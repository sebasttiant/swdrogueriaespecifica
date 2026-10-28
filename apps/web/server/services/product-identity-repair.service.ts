// --------------------------------------------------------------------------
// Audited repair of duplicated product identity (October 2026 incident).
//
// This is the only sanctioned way to fix the rows the incident left behind.
// There is no hand-written UPDATE, and that is the point: a manual statement
// has no drift guard, no plan to review, no transaction boundary and no audit
// trail, so nobody can tell afterwards what it did or whether the database
// still looked the way it did when the change was approved.
//
// Four properties hold the whole design together:
//
//   DRY-RUN BY DEFAULT. `apply` must be requested explicitly. A caller that
//   forgets it gets the plan and an untouched database.
//
//   DRIFT REFUSES. The manifest states what the operator reviewed. If the
//   database no longer matches it — the code moved, a duplicate grew stock, a
//   pending now belongs to someone else — the repair stops with reasons
//   instead of guessing. Repairing a database you no longer recognise is how
//   an incident becomes two incidents.
//
//   NOTHING IS DELETED. Duplicates are deactivated and kept for review. The
//   history of what the operators actually did stays queryable.
//
//   ONE TRANSACTION, FULLY AUDITED. Every write and its audit entry share a
//   transaction, so the repair either lands completely with its trail or does
//   not land at all.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { normalizeOrionCode } from "@/server/domain/catalog/sku-identity";
import {
  recordAuditInTransaction,
  type TransactionalAuditWriter,
} from "@/server/services/transactional-audit.service";

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
  /** Nothing is written unless this is explicitly true. */
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

export async function repairProductIdentity(
  manifest: ProductIdentityRepairManifest,
  deps: { writeAudit?: TransactionalAuditWriter } = {},
): Promise<ProductIdentityRepairReport> {
  const writeAudit = deps.writeAudit ?? recordAuditInTransaction;
  const canonicalCode = normalizeOrionCode(manifest.canonicalOrionCode);
  const blockers: string[] = [];

  const target = await prisma.product.findUnique({
    where: { id: manifest.targetProductId },
    select: { id: true, name: true, orionCode: true, active: true, identityVersion: true },
  });

  if (!target) {
    return blocked([`El producto objetivo ${manifest.targetProductId} no existe.`]);
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
  const codeHolder = await prisma.product.findUnique({
    where: { orionCode: canonicalCode },
    select: { id: true, name: true },
  });
  if (codeHolder && codeHolder.id !== target.id) {
    blockers.push(
      `El código ${canonicalCode} ya pertenece a "${codeHolder.name}" (${codeHolder.id}).`,
    );
  }

  const duplicates = await prisma.product.findMany({
    where: { id: { in: manifest.duplicateProductIds } },
    select: { id: true, name: true, orionCode: true, active: true },
  });
  for (const id of manifest.duplicateProductIds) {
    if (!duplicates.some((duplicate) => duplicate.id === id)) {
      blockers.push(`El duplicado ${id} no existe.`);
    }
  }
  if (manifest.duplicateProductIds.includes(target.id)) {
    blockers.push("El objetivo no puede figurar también como duplicado.");
  }

  // Drift guard #3 — a duplicate with stock or with inventory entries is NOT a
  // duplicate anybody can deactivate from here. Somebody received merchandise
  // against it, and that is a catalog decision, not a repair.
  for (const duplicate of duplicates) {
    const [stock, entries] = await Promise.all([
      prisma.productBatch.aggregate({
        where: { productId: duplicate.id },
        _sum: { quantity: true },
      }),
      prisma.inventoryEntry.count({ where: { productId: duplicate.id } }),
    ]);
    if ((stock._sum.quantity ?? 0) > 0) {
      blockers.push(
        `El duplicado ${duplicate.id} todavía tiene stock (${stock._sum.quantity}).`,
      );
    }
    if (entries > 0) {
      blockers.push(`El duplicado ${duplicate.id} tiene ${entries} entradas de inventario.`);
    }
    if (duplicate.orionCode && duplicate.orionCode !== canonicalCode) {
      blockers.push(
        `El duplicado ${duplicate.id} tiene su propio código ${duplicate.orionCode}: ` +
          `desactivarlo escondería una identidad distinta.`,
      );
    }
  }

  // Drift guard #4 — every listed row must belong to a listed duplicate, or
  // already be on the target. Anything else means the manifest describes a
  // database that is not this one.
  const ownedIds = new Set(duplicates.map((duplicate) => duplicate.id));
  const pendings = await prisma.pending.findMany({
    where: { id: { in: manifest.pendingIds } },
    select: { id: true, productId: true },
  });
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
  }

  const missingItems = await prisma.missingItem.findMany({
    where: { id: { in: manifest.missingItemIds } },
    select: { id: true, productId: true },
  });
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
  }

  if (blockers.length > 0) return blocked(blockers);

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

  const hasWork =
    plan.orionCode !== null ||
    plan.reassignedPendings.length > 0 ||
    plan.reassignedMissingItems.length > 0 ||
    plan.deactivatedProducts.length > 0;

  if (!manifest.apply) {
    return { status: hasWork ? "planned" : "noop", applied: false, plan, blockers: [] };
  }
  if (!hasWork) {
    return { status: "noop", applied: false, plan, blockers: [] };
  }

  await prisma.$transaction(async (tx) => {
    const context = { userId: manifest.actorId };

    if (plan.orionCode) {
      const updated = await tx.product.update({
        where: { id: target.id },
        data: { orionCode: plan.orionCode.to, identityVersion: { increment: 1 } },
        select: { orionCode: true, identityVersion: true },
      });
      await writeAudit(tx, {
        action: AUDIT_ACTIONS.SKU_ORION_LINK,
        module: AUDIT_MODULES.PRODUCTOS,
        entity: "Product",
        entityId: target.id,
        before: { orionCode: plan.orionCode.from, identityVersion: target.identityVersion },
        after: { orionCode: updated.orionCode, identityVersion: updated.identityVersion },
        context,
      });
    }

    for (const pendingId of plan.reassignedPendings) {
      const before = pendings.find((pending) => pending.id === pendingId);
      await tx.pending.update({
        where: { id: pendingId },
        data: { productId: target.id },
      });
      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PRODUCT_UPDATE,
        module: AUDIT_MODULES.PRODUCTOS,
        entity: "Pending",
        entityId: pendingId,
        before: { productId: before?.productId ?? null },
        after: { productId: target.id },
        context,
      });
    }

    for (const missingItemId of plan.reassignedMissingItems) {
      const before = missingItems.find((missingItem) => missingItem.id === missingItemId);
      await tx.missingItem.update({
        where: { id: missingItemId },
        data: { productId: target.id },
      });
      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PRODUCT_UPDATE,
        module: AUDIT_MODULES.PRODUCTOS,
        entity: "MissingItem",
        entityId: missingItemId,
        before: { productId: before?.productId ?? null },
        after: { productId: target.id },
        context,
      });
    }

    for (const duplicateId of plan.deactivatedProducts) {
      // Deactivated and still flagged for review: somebody has to look at it,
      // and a deleted row cannot be looked at.
      await tx.product.update({
        where: { id: duplicateId },
        data: { active: false, needsReview: true },
      });
      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PRODUCT_UPDATE,
        module: AUDIT_MODULES.PRODUCTOS,
        entity: "Product",
        entityId: duplicateId,
        before: { active: true },
        after: { active: false, mergedInto: target.id },
        context,
      });
    }
  });

  return { status: "applied", applied: true, plan, blockers: [] };
}

function blocked(blockers: string[]): ProductIdentityRepairReport {
  return { status: "blocked", applied: false, plan: EMPTY_PLAN, blockers };
}

export function formatRepairReport(report: ProductIdentityRepairReport): string {
  const lines: string[] = [`Estado: ${report.status}`];

  if (report.blockers.length > 0) {
    lines.push("", "Bloqueos (no se escribió nada):");
    for (const blocker of report.blockers) lines.push(`  - ${blocker}`);
    return lines.join("\n");
  }

  lines.push(
    "",
    report.plan.orionCode
      ? `  orionCode: ${report.plan.orionCode.from} -> ${report.plan.orionCode.to}`
      : "  orionCode: sin cambios",
    `  pendientes a reasignar: ${report.plan.reassignedPendings.length}`,
    `  faltantes a reasignar: ${report.plan.reassignedMissingItems.length}`,
    `  productos a desactivar: ${report.plan.deactivatedProducts.length}`,
  );

  if (!report.applied) {
    lines.push("", "Dry-run: no se escribió nada. Usá --apply para ejecutar.");
  }

  return lines.join("\n");
}

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@/lib/generated/prisma/client";
import { MANAGEMENT_STATUSES } from "@/features/pendientes/management-status";
import { canonicalOrionCode, orionNumericCore } from "@/server/domain/catalog/orion-code";
import {
  pickOrionConflictSurvivor,
  type OrionConflictCandidate,
} from "@/server/domain/catalog/orion-conflict-survivor";
import {
  recordAuditInTransaction,
  type TransactionalAuditWriter,
} from "@/server/services/transactional-audit.service";

// --------------------------------------------------------------------------
// WINDOW 3 — fusiona filas que comparten el mismo número de Orión escrito
// distinto (`31972` + `a-31972` → una sola con `A31972`).
//
// Distinto de `repair-product-identity`: esa herramienta se niega a desactivar
// un producto que YA tiene su propio código Orion, porque en el incidente
// SEDATIF `15637` y `A15637` podían ser identidades distintas. Acá el núcleo
// numérico YA demostró que son la misma identidad de Orión (medido en prod el
// 31/10/2026: 160 grupos tras el renombre canónico).
//
// Dry-run por defecto. No mueve stock entre lotes: si dos copias tienen stock,
// el grupo queda bloqueado. El sobreviviente se elige con
// `pickOrionConflictSurvivor`.
// --------------------------------------------------------------------------

const OPEN_PENDING_STATUSES = ["PENDIENTE", "PARCIAL", ...MANAGEMENT_STATUSES] as const;
const OPEN_MISSING_STATUSES = ["FALTANTE", "PEDIDO", "EN_BODEGA"] as const;

export type OrionMergeGroupPlan = {
  core: string;
  canonicalCode: string;
  survivorId: string;
  loserIds: string[];
  pendingIds: string[];
  missingItemIds: string[];
  codes: { id: string; orionCode: string; stock: number }[];
};

export type OrionMergeBlockedGroup = {
  core: string;
  reason: string;
  codes: { id: string; orionCode: string; stock: number }[];
};

export type OrionMergeReport = {
  planned: OrionMergeGroupPlan[];
  blocked: OrionMergeBlockedGroup[];
  applied: boolean;
};

class MergeConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeConcurrencyError";
  }
}

type ProductRow = {
  id: string;
  name: string;
  orionCode: string;
  createdAt: Date;
  active: boolean;
  needsReview: boolean;
  identityVersion: number;
  catalogVersion: number;
};

async function stockForProduct(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<number> {
  const [legacy, canonical] = await Promise.all([
    tx.productBatch.aggregate({
      where: { productId },
      _sum: { quantity: true },
    }),
    tx.lot.aggregate({ where: { productId }, _sum: { onHand: true } }),
  ]);
  return (legacy._sum.quantity ?? 0) + (canonical._sum.onHand ?? 0);
}

/**
 * Calcula el plan de merge. Con `apply` escribe grupo por grupo en su propia
 * transacción: un grupo bloqueado a mitad de camino no deshace los ya hechos.
 */
export async function mergeOrionConflicts(
  options: { apply?: boolean; actorId: string },
  deps: { writeAudit?: TransactionalAuditWriter } = {},
): Promise<OrionMergeReport> {
  const writeAudit = deps.writeAudit ?? recordAuditInTransaction;
  const apply = options.apply === true;

  const products = (await prisma.product.findMany({
    where: { active: true, orionCode: { not: null } },
    select: {
      id: true,
      name: true,
      orionCode: true,
      createdAt: true,
      active: true,
      needsReview: true,
      identityVersion: true,
      catalogVersion: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })) as ProductRow[];

  const byCore = new Map<string, ProductRow[]>();
  for (const product of products) {
    const core = orionNumericCore(product.orionCode);
    const group = byCore.get(core);
    if (group) group.push(product);
    else byCore.set(core, [product]);
  }

  const planned: OrionMergeGroupPlan[] = [];
  const blocked: OrionMergeBlockedGroup[] = [];

  for (const [core, group] of byCore) {
    if (group.length < 2) continue;

    const stocks = new Map<string, number>();
    for (const product of group) {
      stocks.set(product.id, await stockForProduct(prisma, product.id));
    }

    const codes = group.map((product) => ({
      id: product.id,
      orionCode: product.orionCode,
      stock: stocks.get(product.id) ?? 0,
    }));

    const canonicalCode = canonicalOrionCode(group[0]!.orionCode);
    const candidates: OrionConflictCandidate[] = group.map((product) => ({
      id: product.id,
      orionCode: product.orionCode,
      stock: stocks.get(product.id) ?? 0,
      createdAt: product.createdAt,
    }));

    const decision = pickOrionConflictSurvivor(canonicalCode, candidates);
    if (decision.status === "blocked") {
      blocked.push({ core, reason: decision.reason, codes });
      continue;
    }

    const survivorId = decision.survivorId;
    const losers = group.filter((product) => product.id !== survivorId);

    // Los perdedores con stock no deberían llegar acá (la heurística lo evita),
    // pero se re-chequea: el merge no mueve lotes.
    const stockOnLoser = losers.find((product) => (stocks.get(product.id) ?? 0) > 0);
    if (stockOnLoser) {
      blocked.push({
        core,
        reason: `El perdedor ${stockOnLoser.id} todavía tiene stock.`,
        codes,
      });
      continue;
    }

    const loserIds = losers.map((product) => product.id);
    const [openPendings, openMissing] = await Promise.all([
      prisma.pending.findMany({
        where: { productId: { in: loserIds }, status: { in: [...OPEN_PENDING_STATUSES] } },
        select: { id: true },
      }),
      prisma.missingItem.findMany({
        where: { productId: { in: loserIds }, status: { in: [...OPEN_MISSING_STATUSES] } },
        select: { id: true },
      }),
    ]);

    planned.push({
      core,
      canonicalCode,
      survivorId,
      loserIds,
      pendingIds: openPendings.map((row) => row.id),
      missingItemIds: openMissing.map((row) => row.id),
      codes,
    });
  }

  if (!apply) return { planned, blocked, applied: false };

  const stillPlanned: OrionMergeGroupPlan[] = [];
  const newlyBlocked: OrionMergeBlockedGroup[] = [...blocked];

  for (const plan of planned) {
    try {
      await prisma.$transaction(async (tx) => {
        await applyOneGroup(tx, plan, options.actorId, writeAudit);
      });
      stillPlanned.push(plan);
    } catch (error) {
      if (error instanceof MergeConcurrencyError) {
        newlyBlocked.push({
          core: plan.core,
          reason: error.message,
          codes: plan.codes,
        });
        continue;
      }
      throw error;
    }
  }

  return { planned: stillPlanned, blocked: newlyBlocked, applied: true };
}

async function applyOneGroup(
  tx: Prisma.TransactionClient,
  plan: OrionMergeGroupPlan,
  actorId: string,
  writeAudit: TransactionalAuditWriter,
): Promise<void> {
  const context = { userId: actorId };
  const allIds = [plan.survivorId, ...plan.loserIds];

  const locked = await tx.$queryRaw<
    {
      id: string;
      orionCode: string | null;
      active: boolean;
      needsReview: boolean;
      identityVersion: number;
      catalogVersion: number;
    }[]
  >`
    SELECT id, "orionCode", active, "needsReview", "identityVersion", "catalogVersion"
      FROM products
     WHERE id = ANY(${allIds}::text[])
     ORDER BY id
       FOR UPDATE
  `;

  const byId = new Map(locked.map((row) => [row.id, row]));
  const survivor = byId.get(plan.survivorId);
  if (!survivor || !survivor.active) {
    throw new MergeConcurrencyError(
      `El sobreviviente ${plan.survivorId} no está activo o desapareció.`,
    );
  }

  for (const loserId of plan.loserIds) {
    const loser = byId.get(loserId);
    if (!loser || !loser.active) {
      throw new MergeConcurrencyError(`El perdedor ${loserId} cambió durante el merge.`);
    }
    if ((await stockForProduct(tx, loserId)) > 0) {
      throw new MergeConcurrencyError(`El perdedor ${loserId} adquirió stock durante el merge.`);
    }
    if (
      loser.orionCode !== null &&
      orionNumericCore(loser.orionCode) !== plan.core
    ) {
      throw new MergeConcurrencyError(
        `El perdedor ${loserId} ya no comparte el núcleo ${plan.core}.`,
      );
    }
  }

  // 1) Liberar códigos de los perdedores (única: el canónico puede estar en
  //    uno de ellos).
  for (const loserId of plan.loserIds) {
    const loser = byId.get(loserId)!;
    if (loser.orionCode === null) continue;
    const released = await tx.product.updateMany({
      where: { id: loserId, identityVersion: loser.identityVersion },
      data: { orionCode: null, identityVersion: { increment: 1 } },
    });
    if (released.count !== 1) {
      throw new MergeConcurrencyError(`No se pudo liberar el código de ${loserId}.`);
    }
    await writeAudit(tx, {
      action: AUDIT_ACTIONS.SKU_ORION_RELEASE,
      module: AUDIT_MODULES.PRODUCTOS,
      entity: "Product",
      entityId: loserId,
      before: { orionCode: loser.orionCode, identityVersion: loser.identityVersion },
      after: {
        orionCode: null,
        identityVersion: loser.identityVersion + 1,
        reason: "ORION_CORE_MERGE",
        mergedIntoProductId: plan.survivorId,
      },
      context,
    });
    loser.identityVersion += 1;
    loser.orionCode = null;
  }

  // 2) Canónico en el sobreviviente.
  if (survivor.orionCode !== plan.canonicalCode) {
    const from = survivor.orionCode;
    const fixed = await tx.product.updateMany({
      where: { id: survivor.id, identityVersion: survivor.identityVersion },
      data: { orionCode: plan.canonicalCode, identityVersion: { increment: 1 } },
    });
    if (fixed.count !== 1) {
      throw new MergeConcurrencyError(
        `No se pudo canonizar el sobreviviente ${survivor.id}.`,
      );
    }
    await writeAudit(tx, {
      action: AUDIT_ACTIONS.SKU_ORION_FIX,
      module: AUDIT_MODULES.PRODUCTOS,
      entity: "Product",
      entityId: survivor.id,
      before: { orionCode: from, identityVersion: survivor.identityVersion },
      after: {
        orionCode: plan.canonicalCode,
        identityVersion: survivor.identityVersion + 1,
        reason: "ORION_CORE_MERGE",
      },
      context,
    });
    survivor.identityVersion += 1;
    survivor.orionCode = plan.canonicalCode;
  }

  // 3) Reasignar pendientes y faltantes abiertos de los perdedores.
  for (const pendingId of plan.pendingIds) {
    const before = await tx.pending.findUnique({
      where: { id: pendingId },
      select: { id: true, productId: true, status: true },
    });
    if (!before || !plan.loserIds.includes(before.productId)) {
      throw new MergeConcurrencyError(`El pendiente ${pendingId} ya no pertenece al grupo.`);
    }
    const moved = await tx.pending.updateMany({
      where: { id: pendingId, productId: before.productId, status: before.status as never },
      data: { productId: plan.survivorId },
    });
    if (moved.count !== 1) {
      throw new MergeConcurrencyError(`El pendiente ${pendingId} cambió durante el merge.`);
    }
    await writeAudit(tx, {
      action: AUDIT_ACTIONS.PENDING_UPDATE,
      module: AUDIT_MODULES.PRODUCTOS,
      entity: "Pending",
      entityId: pendingId,
      before: { productId: before.productId, status: before.status },
      after: { productId: plan.survivorId, status: before.status, reason: "ORION_CORE_MERGE" },
      context,
    });
  }

  for (const missingItemId of plan.missingItemIds) {
    const before = await tx.missingItem.findUnique({
      where: { id: missingItemId },
      select: { id: true, productId: true, status: true },
    });
    if (!before || !plan.loserIds.includes(before.productId)) {
      throw new MergeConcurrencyError(`El faltante ${missingItemId} ya no pertenece al grupo.`);
    }
    const moved = await tx.missingItem.updateMany({
      where: {
        id: missingItemId,
        productId: before.productId,
        status: before.status as never,
      },
      data: { productId: plan.survivorId },
    });
    if (moved.count !== 1) {
      throw new MergeConcurrencyError(`El faltante ${missingItemId} cambió durante el merge.`);
    }
    await writeAudit(tx, {
      action: AUDIT_ACTIONS.MISSING_STATUS_CHANGE,
      module: AUDIT_MODULES.PRODUCTOS,
      entity: "MissingItem",
      entityId: missingItemId,
      before: { productId: before.productId, status: before.status },
      after: { productId: plan.survivorId, status: before.status, reason: "ORION_CORE_MERGE" },
      context,
    });
  }

  // 4) Desactivar perdedores.
  for (const loserId of plan.loserIds) {
    const loser = byId.get(loserId)!;
    const deactivated = await tx.product.updateMany({
      where: { id: loserId, active: true, catalogVersion: loser.catalogVersion },
      data: { active: false, needsReview: true, catalogVersion: { increment: 1 } },
    });
    if (deactivated.count !== 1) {
      throw new MergeConcurrencyError(`No se pudo desactivar ${loserId}.`);
    }
    await writeAudit(tx, {
      action: AUDIT_ACTIONS.PRODUCT_UPDATE,
      module: AUDIT_MODULES.PRODUCTOS,
      entity: "Product",
      entityId: loserId,
      before: {
        active: true,
        needsReview: loser.needsReview,
        catalogVersion: loser.catalogVersion,
      },
      after: {
        active: false,
        needsReview: true,
        catalogVersion: loser.catalogVersion + 1,
        replacedByProductId: plan.survivorId,
        reason: "ORION_CORE_MERGE",
      },
      context,
    });
  }
}

export function formatOrionMergeReport(report: OrionMergeReport): string {
  const lines: string[] = [
    `Estado: ${report.applied ? "aplicado" : "plan"}`,
    "",
    `merges (${report.planned.length}):`,
  ];

  for (const plan of report.planned) {
    const codes = plan.codes.map((row) => `${row.orionCode}[${row.stock}]`).join(" | ");
    lines.push(
      `  - nº ${plan.core} → ${plan.canonicalCode}  survivor=${plan.survivorId}`,
      `      copias: ${codes}`,
      `      losers: ${plan.loserIds.join(", ") || "(ninguno)"}`,
      `      pendings=${plan.pendingIds.length} missing=${plan.missingItemIds.length}`,
    );
  }
  if (report.planned.length === 0) lines.push("  (ninguno)");

  lines.push("", `bloqueados (${report.blocked.length}):`);
  for (const group of report.blocked) {
    const codes = group.codes.map((row) => `${row.orionCode}[${row.stock}]`).join(" | ");
    lines.push(`  - nº ${group.core}: ${codes}`);
    lines.push(`      motivo: ${group.reason}`);
  }
  if (report.blocked.length === 0) lines.push("  (ninguno)");

  if (!report.applied) {
    lines.push("", "Dry-run: no se escribió nada. Usá --apply para ejecutar.");
  }

  return lines.join("\n");
}

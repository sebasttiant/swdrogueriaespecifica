import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import {
  repairPendingProduct,
  type ApprovedPendingProductRepair,
  type PendingProductRepairManifest,
} from "@/server/services/pending-product-repair.service";
import type { TransactionalAuditWriter } from "@/server/services/transactional-audit.service";

let actorId = "";
let currentProductId = "";
let targetProductId = "";
let pendingId = "";
let approvedRepair: ApprovedPendingProductRepair;

async function cleanup() {
  const productIds = [currentProductId, targetProductId].filter(Boolean);
  if (pendingId) {
    await prisma.auditLog.deleteMany({ where: { entityId: pendingId } });
    await prisma.pendingDelivery.deleteMany({ where: { pendingId } });
    await prisma.pendingInventoryReservation.deleteMany({ where: { pendingId } });
    await prisma.inventoryAllocation.deleteMany({ where: { pendingId } });
    await prisma.missingItem.deleteMany({ where: { originId: pendingId } });
    await prisma.pending.deleteMany({ where: { id: pendingId } });
  }
  await prisma.productBatch.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
}

beforeEach(async () => {
  const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const actor = await prisma.user.create({
    data: { email: `admin-${stamp}@test.local`, name: "Repair administrator", role: "ADMIN" },
  });
  actorId = actor.id;
  const current = await prisma.product.create({
    data: { code: `PROV-${stamp}`, name: "ATODER", unit: "unidad" },
  });
  currentProductId = current.id;
  const target = await prisma.product.create({
    data: {
      code: `MAN-${stamp}`,
      name: "CITIVITAE 1000 MG X 10 SOBRES",
      unit: "caja",
      orionCode: `A${stamp.replaceAll("-", "").slice(-8)}`,
    },
  });
  targetProductId = target.id;
  const pending = await prisma.pending.create({
    data: {
      productId: currentProductId,
      quantity: 2,
      status: "PENDIENTE",
      purchaseStatus: "SOLICITADO",
      availabilityStatus: "ESPERANDO",
      customerStatus: "POR_CONTACTAR",
      customerName: "Test customer",
      promisedAt: new Date("2030-01-01T00:00:00.000Z"),
      idempotencyKey: randomUUID(),
      createdById: actorId,
    },
  });
  pendingId = pending.id;
  approvedRepair = {
    repairId: `test-repair-${stamp}`,
    actorEmail: actor.email,
    pendingId,
    expectedCurrentProductId: currentProductId,
    expectedCurrentProductName: current.name,
    expectedCurrentProductOrionCode: current.orionCode,
    targetProductId,
    expectedQuantity: 2,
    expectedStatus: "PENDIENTE",
    expectedPurchaseStatus: "SOLICITADO",
    expectedAvailabilityStatus: "ESPERANDO",
    expectedCustomerStatus: "POR_CONTACTAR",
    expectedTargetName: target.name,
    expectedTargetOrionCode: target.orionCode!,
    reason: "Restore the product confirmed by the original request fingerprint.",
  };
});

afterEach(cleanup);

function manifest(overrides: Partial<PendingProductRepairManifest> = {}) {
  return { ...approvedRepair, ...overrides };
}

function repair(
  value: PendingProductRepairManifest,
  writeAudit?: TransactionalAuditWriter,
) {
  return repairPendingProduct(value, { approvedRepair, writeAudit });
}

describe("repairPendingProduct", () => {
  it("defaults to dry-run and changes neither data nor audit", async () => {
    const report = await repair(manifest());
    expect(report).toMatchObject({ status: "planned", applied: false });
    expect((await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } })).productId).toBe(
      currentProductId,
    );
    expect(await prisma.auditLog.count({ where: { entityId: pendingId } })).toBe(0);
  });

  it("changes only productId plus updatedAt, audits atomically, and replays as noop", async () => {
    const before = await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } });
    expect(await repair(manifest({ apply: true }))).toMatchObject({ status: "applied", applied: true });
    const after = await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } });
    const { productId: beforeProductId, updatedAt: beforeUpdatedAt, ...beforeUnchanged } = before;
    const { productId: afterProductId, updatedAt: afterUpdatedAt, ...afterUnchanged } = after;
    expect(beforeProductId).toBe(currentProductId);
    expect(afterProductId).toBe(targetProductId);
    expect(afterUpdatedAt.getTime()).toBeGreaterThanOrEqual(beforeUpdatedAt.getTime());
    expect(afterUnchanged).toEqual(beforeUnchanged);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: pendingId } });
    expect(audit).toMatchObject({
      action: AUDIT_ACTIONS.PENDING_UPDATE,
      module: AUDIT_MODULES.PENDIENTES,
      userId: actorId,
      channel: approvedRepair.repairId,
    });
    expect(audit.before).toMatchObject({ productId: currentProductId, quantity: 2 });
    expect(audit.after).toMatchObject({ productId: targetProductId, quantity: 2 });

    expect(await repair(manifest({ apply: true }))).toMatchObject({ status: "noop", applied: false });
    expect(await prisma.auditLog.count({ where: { entityId: pendingId } })).toBe(1);
  });

  it("blocks manifest or database drift without mutation", async () => {
    const report = await repair(manifest({ expectedQuantity: 1, apply: true }));
    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toContain("aprobada");
    expect(report.blockers.join(" ")).toContain("cantidad");
    expect((await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } })).productId).toBe(
      currentProductId,
    );
    expect(await prisma.auditLog.count({ where: { entityId: pendingId } })).toBe(0);
  });

  it("blocks any fulfillment or commercial lifecycle state", async () => {
    await prisma.pending.update({
      where: { id: pendingId },
      data: { inventoryReadyQuantity: 1, reservedInventoryQuantity: 1 },
    });
    const report = await repair(manifest({ apply: true }));
    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toContain("inventario");
    expect((await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } })).productId).toBe(
      currentProductId,
    );
  });

  it("blocks inactive actors and mismatched current or target identities", async () => {
    await prisma.user.update({ where: { id: actorId }, data: { active: false } });
    await prisma.product.update({ where: { id: currentProductId }, data: { name: "DRIFTED" } });
    const report = await repair(manifest({ expectedTargetOrionCode: "A-WRONG", apply: true }));
    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toContain("actor");
    expect(report.blockers.join(" ")).toContain("actual");
    expect(report.blockers.join(" ")).toContain("objetivo");
    expect(await prisma.auditLog.count({ where: { entityId: pendingId } })).toBe(0);
  });

  it("rolls back the product change when transactional audit fails", async () => {
    await expect(
      repair(manifest({ apply: true }), async () => Promise.reject(new Error("audit unavailable"))),
    ).rejects.toThrow("audit unavailable");
    expect((await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } })).productId).toBe(
      currentProductId,
    );
    expect(await prisma.auditLog.count({ where: { entityId: pendingId } })).toBe(0);
  });
});

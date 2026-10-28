import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import { repairProductIdentity } from "@/server/services/product-identity-repair.service";

// --------------------------------------------------------------------------
// Audited repair of the October 2026 duplicate-identity incident.
//
// This runs against real PostgreSQL because every safety property it claims is
// a property of the DATABASE: the unique index on `orionCode`, the foreign keys
// of pendings and missing items, and the transaction that makes the whole
// repair atomic. A mocked client would happily "pass" while production rejects
// the same statements.
//
// The rules the tests below pin, in order of importance:
//   1. Dry-run is the DEFAULT. A caller that forgets `apply` changes nothing.
//   2. Drift blocks the repair. If the database no longer looks like the
//      manifest that was reviewed, the repair refuses instead of guessing.
//   3. Duplicates are DEACTIVATED, never deleted. History survives.
//   4. A duplicate holding stock or inventory entries is never touched.
//   5. Every write leaves an audit entry inside the same transaction.
// --------------------------------------------------------------------------

const CANONICAL_CODE = "A15637";

let actorId = "";
let targetId = "";
let duplicateId = "";
let pendingId = "";
let missingItemId = "";
let staleCode = "";

async function cleanup() {
  const ids = [targetId, duplicateId].filter(Boolean);
  if (ids.length === 0) return;
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ids, pendingId, missingItemId].filter(Boolean) } } });
  await prisma.missingItem.deleteMany({ where: { productId: { in: ids } } });
  await prisma.pending.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productBatch.deleteMany({ where: { productId: { in: ids } } });
  await prisma.inventoryEntry.deleteMany({ where: { productId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(async () => {
  const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  staleCode = `A-15637-${stamp}`;

  const actor = await prisma.user.create({
    data: { email: `repair-${stamp}@test.local`, name: "Repair actor" },
  });
  actorId = actor.id;

  const target = await prisma.product.create({
    data: {
      code: `MAN-TARGET-${stamp}`,
      name: "SEDATIF PC X 40 TABLETAS",
      unit: "Caja",
      orionCode: staleCode,
      needsReview: true,
    },
  });
  targetId = target.id;

  // The target is the one that holds the stock: that is exactly why it is the
  // product that must survive the repair.
  await prisma.productBatch.create({
    data: { productId: targetId, batchCode: `LOTE-${stamp}`, quantity: 2 },
  });

  const duplicate = await prisma.product.create({
    data: {
      code: `MAN-DUP-${stamp}`,
      name: "SEDATIF PC X 40 TABLETAS",
      unit: "Caja",
      needsReview: true,
    },
  });
  duplicateId = duplicate.id;

  const pending = await prisma.pending.create({
    data: {
      productId: duplicateId,
      quantity: 1,
      promisedAt: new Date("2030-01-01T00:00:00.000Z"),
      idempotencyKey: randomUUID(),
      createdById: actorId,
    },
  });
  pendingId = pending.id;

  const missingItem = await prisma.missingItem.create({
    data: { productId: duplicateId, quantity: 1, originId: pendingId },
  });
  missingItemId = missingItem.id;
});

afterEach(cleanup);

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    actorId,
    targetProductId: targetId,
    expectedTargetOrionCode: staleCode,
    canonicalOrionCode: CANONICAL_CODE,
    duplicateProductIds: [duplicateId],
    pendingIds: [pendingId],
    missingItemIds: [missingItemId],
    ...overrides,
  };
}

describe("repairProductIdentity", () => {
  it("plans the repair without writing anything when apply is omitted", async () => {
    const report = await repairProductIdentity(manifest());

    expect(report.status).toBe("planned");
    expect(report.applied).toBe(false);
    expect(report.plan).toMatchObject({
      orionCode: { from: staleCode, to: CANONICAL_CODE },
      reassignedPendings: [pendingId],
      reassignedMissingItems: [missingItemId],
      deactivatedProducts: [duplicateId],
    });

    const target = await prisma.product.findUniqueOrThrow({ where: { id: targetId } });
    const pending = await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } });
    expect(target.orionCode).toBe(staleCode);
    expect(pending.productId).toBe(duplicateId);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: duplicateId } })).toMatchObject({
      active: true,
    });
    expect(await prisma.auditLog.count({ where: { entityId: targetId } })).toBe(0);
  });

  it("applies the whole repair in one transaction and leaves an audit trail", async () => {
    const report = await repairProductIdentity({ ...manifest(), apply: true });

    expect(report.status).toBe("applied");
    expect(report.applied).toBe(true);

    const target = await prisma.product.findUniqueOrThrow({ where: { id: targetId } });
    const duplicate = await prisma.product.findUniqueOrThrow({ where: { id: duplicateId } });
    const pending = await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } });
    const missingItem = await prisma.missingItem.findUniqueOrThrow({ where: { id: missingItemId } });

    expect(target.orionCode).toBe(CANONICAL_CODE);
    expect(pending.productId).toBe(targetId);
    expect(missingItem.productId).toBe(targetId);
    // Deactivated, never deleted: the row and its history stay queryable.
    expect(duplicate.active).toBe(false);
    expect(duplicate.needsReview).toBe(true);

    const audits = await prisma.auditLog.findMany({
      where: { entityId: { in: [targetId, duplicateId, pendingId, missingItemId] } },
    });
    expect(audits.length).toBeGreaterThanOrEqual(4);
    expect(audits.every((entry) => entry.module === AUDIT_MODULES.PRODUCTOS)).toBe(true);
    expect(audits.some((entry) => entry.action === AUDIT_ACTIONS.SKU_ORION_LINK)).toBe(true);
    expect(audits.every((entry) => entry.userId === actorId)).toBe(true);
  });

  it("refuses when the current code is not the one the manifest was reviewed against", async () => {
    await prisma.product.update({
      where: { id: targetId },
      data: { orionCode: `${staleCode}-MOVED` },
    });

    const report = await repairProductIdentity({ ...manifest(), apply: true });

    expect(report.status).toBe("blocked");
    expect(report.applied).toBe(false);
    expect(report.blockers.join(" ")).toMatch(/orionCode/i);
    expect(await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } })).toMatchObject({
      productId: duplicateId,
    });
  });

  it("refuses to deactivate a duplicate that still holds stock", async () => {
    await prisma.productBatch.create({
      data: { productId: duplicateId, batchCode: `LOTE-DUP-${Date.now()}`, quantity: 5 },
    });

    const report = await repairProductIdentity({ ...manifest(), apply: true });

    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toMatch(/stock/i);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: duplicateId } })).toMatchObject({
      active: true,
    });
    expect(await prisma.product.findUniqueOrThrow({ where: { id: targetId } })).toMatchObject({
      orionCode: staleCode,
    });
  });

  it("refuses when a listed pending does not belong to a listed duplicate", async () => {
    const stranger = await prisma.product.create({
      data: { code: `MAN-OTHER-${Date.now()}`, name: "Otro producto", unit: "Caja" },
    });
    const strangerPending = await prisma.pending.create({
      data: {
        productId: stranger.id,
        quantity: 1,
        promisedAt: new Date("2030-01-01T00:00:00.000Z"),
        idempotencyKey: randomUUID(),
        createdById: actorId,
      },
    });

    const report = await repairProductIdentity({
      ...manifest({ pendingIds: [pendingId, strangerPending.id] }),
      apply: true,
    });

    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toContain(strangerPending.id);

    await prisma.pending.deleteMany({ where: { productId: stranger.id } });
    await prisma.product.delete({ where: { id: stranger.id } });

    expect(await prisma.product.findUniqueOrThrow({ where: { id: targetId } })).toMatchObject({
      orionCode: staleCode,
    });
  });

  it("is idempotent: a second apply finds nothing left to repair", async () => {
    await repairProductIdentity({ ...manifest(), apply: true });

    const second = await repairProductIdentity({
      ...manifest({ expectedTargetOrionCode: CANONICAL_CODE }),
      apply: true,
    });

    expect(second.status).toBe("noop");
    expect(second.plan.reassignedPendings).toEqual([]);
    expect(second.plan.deactivatedProducts).toEqual([]);
  });
});

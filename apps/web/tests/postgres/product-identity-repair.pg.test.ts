import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import {
  formatRepairReport,
  repairProductIdentity,
} from "@/server/services/product-identity-repair.service";

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
// Every row this file creates, so cleanup never depends on which assertion
// happened to fail first.
let extraProductIds: string[] = [];

async function cleanup() {
  const ids = [targetId, duplicateId, ...extraProductIds].filter(Boolean);
  if (ids.length === 0) return;
  await prisma.auditLog.deleteMany({
    where: { entityId: { in: [...ids, pendingId, missingItemId].filter(Boolean) } },
  });
  await prisma.auditLog.deleteMany({ where: { userId: actorId } });
  await prisma.missingItem.deleteMany({ where: { productId: { in: ids } } });
  await prisma.pending.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productBatch.deleteMany({ where: { productId: { in: ids } } });
  await prisma.lot.deleteMany({ where: { productId: { in: ids } } });
  await prisma.inventoryEntry.deleteMany({ where: { productId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: actorId } });
  extraProductIds = [];
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
    // RELINK and not LINK: the product already carried a code, so this is a
    // correction of identity, not a first assignment.
    expect(audits.some((entry) => entry.action === AUDIT_ACTIONS.SKU_ORION_RELINK)).toBe(true);
    expect(audits.some((entry) => entry.action === AUDIT_ACTIONS.SKU_ORION_LINK)).toBe(false);
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

  it("is idempotent: replaying the SAME manifest finds nothing left to repair", async () => {
    await repairProductIdentity({ ...manifest(), apply: true });
    const auditsAfterFirst = await prisma.auditLog.count({ where: { userId: actorId } });

    // The exact manifest, unchanged: this is what the runbook replays.
    const second = await repairProductIdentity({ ...manifest(), apply: true });

    expect(second.status).toBe("noop");
    expect(second.applied).toBe(false);
    expect(second.plan.reassignedPendings).toEqual([]);
    expect(second.plan.reassignedMissingItems).toEqual([]);
    expect(second.plan.deactivatedProducts).toEqual([]);
    // A no-op writes no audit entries: a replay is not an event.
    expect(await prisma.auditLog.count({ where: { userId: actorId } })).toBe(auditsAfterFirst);
  });

  it("preserves the target's lot and its 2 units", async () => {
    await repairProductIdentity({ ...manifest(), apply: true });

    const batches = await prisma.productBatch.findMany({ where: { productId: targetId } });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.quantity).toBe(2);
  });

  it("refuses to deactivate a duplicate holding CANONICAL lot stock", async () => {
    await prisma.lot.create({
      data: {
        productId: duplicateId,
        lotNumber: `LOT-CANON-${Date.now()}`,
        onHand: 3,
      },
    });

    const report = await repairProductIdentity({ ...manifest(), apply: true });

    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toMatch(/stock can[oó]nico/i);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: duplicateId } })).toMatchObject({
      active: true,
    });
  });

  it("refuses when the duplicate has an inventory entry", async () => {
    await prisma.inventoryEntry.create({
      data: {
        productId: duplicateId,
        quantity: 1,
        createdById: actorId,
        requestFingerprint: randomUUID(),
      },
    });

    const report = await repairProductIdentity({ ...manifest(), apply: true });

    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toMatch(/entradas de inventario/i);
  });

  it("refuses when the canonical code already belongs to another product", async () => {
    const holder = await prisma.product.create({
      data: {
        code: `MAN-HOLDER-${Date.now()}`,
        name: "Dueño del código",
        unit: "Caja",
        orionCode: CANONICAL_CODE,
      },
    });
    extraProductIds.push(holder.id);

    const report = await repairProductIdentity({ ...manifest(), apply: true });

    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toContain(holder.id);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: targetId } })).toMatchObject({
      orionCode: staleCode,
    });
  });

  it("refuses when the duplicate carries its OWN different code", async () => {
    await prisma.product.update({
      where: { id: duplicateId },
      data: { orionCode: `OTRO-${Date.now()}` },
    });

    const report = await repairProductIdentity({ ...manifest(), apply: true });

    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toMatch(/identidad distinta/i);
  });

  it("refuses when the duplicate has an OPEN pending the manifest does not list", async () => {
    const unlisted = await prisma.pending.create({
      data: {
        productId: duplicateId,
        quantity: 1,
        promisedAt: new Date("2030-01-01T00:00:00.000Z"),
        idempotencyKey: randomUUID(),
        createdById: actorId,
      },
    });

    const report = await repairProductIdentity({ ...manifest(), apply: true });

    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toContain(unlisted.id);
    // The listed pending stays where it was: nothing was written.
    expect(await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } })).toMatchObject({
      productId: duplicateId,
    });
  });

  // The legacy management statuses are NOT terminal: the fulfillment-lifecycle
  // migration copied them into `purchaseStatus` without clearing `status`, so
  // historical rows still carry them. Ignoring them would deactivate the
  // duplicate while its live pending stays attached to an invisible product.
  it.each(["SOLICITADO", "BUSQUEDA", "COTIZANDO", "AGOTADO"])(
    "refuses when the duplicate has an unlisted pending in legacy state %s",
    async (status) => {
      const unlisted = await prisma.pending.create({
        data: {
          productId: duplicateId,
          quantity: 1,
          promisedAt: new Date("2030-01-01T00:00:00.000Z"),
          idempotencyKey: randomUUID(),
          createdById: actorId,
          status: status as never,
        },
      });

      const report = await repairProductIdentity({ ...manifest(), apply: true });

      expect(report.status).toBe("blocked");
      expect(report.blockers.join(" ")).toContain(unlisted.id);
      expect(
        await prisma.product.findUniqueOrThrow({ where: { id: duplicateId } }),
      ).toMatchObject({ active: true });
    },
  );

  it.each(["SOLICITADO", "BUSQUEDA", "COTIZANDO", "AGOTADO"])(
    "reassigns a listed pending in legacy state %s instead of calling it closed",
    async (status) => {
      await prisma.pending.update({
        where: { id: pendingId },
        data: { status: status as never },
      });

      const report = await repairProductIdentity({ ...manifest(), apply: true });

      expect(report.status).toBe("applied");
      expect(await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } })).toMatchObject({
        productId: targetId,
        status,
      });
    },
  );

  // The row lock only covers the repair transaction. A catalog-edit form opened
  // before the repair would otherwise be accepted afterwards and silently
  // reactivate the duplicate, because its stale `active: true` still matches.
  it("advances the duplicate's catalogVersion so a stale catalog edit is rejected", async () => {
    const before = await prisma.product.findUniqueOrThrow({
      where: { id: duplicateId },
      select: { catalogVersion: true },
    });

    expect((await repairProductIdentity({ ...manifest(), apply: true })).status).toBe("applied");

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: duplicateId },
      select: { active: true, catalogVersion: true },
    });
    expect(after.active).toBe(false);
    expect(after.catalogVersion).toBe(before.catalogVersion + 1);

    // The stale form, replayed with the version it was rendered with, no longer
    // matches: the existing optimistic-concurrency check rejects it.
    const staleEdit = await prisma.product.updateMany({
      where: { id: duplicateId, catalogVersion: before.catalogVersion },
      data: { active: true },
    });
    expect(staleEdit.count).toBe(0);
  });

  it("audits the duplicate's REAL prior review state, not a state that never existed", async () => {
    await prisma.product.update({
      where: { id: duplicateId },
      data: { needsReview: false },
    });

    expect((await repairProductIdentity({ ...manifest(), apply: true })).status).toBe("applied");

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: duplicateId, entity: "Product" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry.before).toMatchObject({ active: true, needsReview: false });
    expect(entry.after).toMatchObject({ active: false, needsReview: true });
  });

  it("refuses to reassign a CLOSED pending: that would rewrite history", async () => {
    await prisma.pending.update({
      where: { id: pendingId },
      data: { status: "ENTREGADO" },
    });

    const report = await repairProductIdentity({ ...manifest(), apply: true });

    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toMatch(/historia cerrada/i);
    expect(await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } })).toMatchObject({
      productId: duplicateId,
    });
  });

  it("refuses when the target does not exist", async () => {
    const report = await repairProductIdentity({
      ...manifest({ targetProductId: "producto-que-no-existe" }),
      apply: true,
    });

    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toMatch(/no existe/i);
  });

  it("refuses when the target is also listed as a duplicate", async () => {
    const report = await repairProductIdentity({
      ...manifest({ duplicateProductIds: [duplicateId, targetId] }),
      apply: true,
    });

    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toMatch(/no puede figurar/i);
  });

  it("rolls everything back when the audit write fails", async () => {
    await expect(
      repairProductIdentity(
        { ...manifest(), apply: true },
        {
          writeAudit: async () => {
            throw new Error("audit unavailable");
          },
        },
      ),
    ).rejects.toThrow("audit unavailable");

    // No write survives an unauditable repair.
    expect(await prisma.product.findUniqueOrThrow({ where: { id: targetId } })).toMatchObject({
      orionCode: staleCode,
    });
    expect(await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } })).toMatchObject({
      productId: duplicateId,
    });
    expect(await prisma.product.findUniqueOrThrow({ where: { id: duplicateId } })).toMatchObject({
      active: true,
    });
  });

  it("treats a non-boolean apply as a dry run", async () => {
    const report = await repairProductIdentity({
      ...manifest(),
      // A hand-written manifest can carry a string. Truthiness must not write.
      apply: "false" as unknown as boolean,
    });

    expect(report.applied).toBe(false);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: targetId } })).toMatchObject({
      orionCode: staleCode,
    });
  });

  it("prints every id so the plan can be compared, never just counts", async () => {
    const report = await repairProductIdentity(manifest());
    const text = formatRepairReport(report);

    expect(text).toContain(pendingId);
    expect(text).toContain(missingItemId);
    expect(text).toContain(duplicateId);
    expect(text).toContain(CANONICAL_CODE);
    expect(text).toMatch(/dry-run/i);
  });

  it("audits one entry per effect, with the real prior state", async () => {
    await repairProductIdentity({ ...manifest(), apply: true });

    const audits = await prisma.auditLog.findMany({ where: { userId: actorId } });
    const byEntity = (entity: string, entityId: string) =>
      audits.filter((entry) => entry.entity === entity && entry.entityId === entityId);

    expect(byEntity("Product", targetId)).toHaveLength(1);
    expect(byEntity("Pending", pendingId)).toHaveLength(1);
    expect(byEntity("MissingItem", missingItemId)).toHaveLength(1);
    expect(byEntity("Product", duplicateId)).toHaveLength(1);

    expect(byEntity("Product", targetId)[0]?.before).toMatchObject({ orionCode: staleCode });
    expect(byEntity("Pending", pendingId)[0]?.before).toMatchObject({
      productId: duplicateId,
    });
  });
});

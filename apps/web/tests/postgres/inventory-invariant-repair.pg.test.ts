import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import {
  INVENTORY_INVARIANT_REPAIR_COMMAND,
  repairInventoryInvariant,
} from "@/server/services/inventory-invariant-repair.service";

// --------------------------------------------------------------------------
// Legacy repair for #332. Before the fix, a reception that allocated units to
// a pending subtracted them from the batch, and registration promised stock
// without writing reservation rows. These tests seed that legacy state with
// direct writes (the old code no longer exists) and check that the repair
// restores the physical-total invariant exactly once, fails closed on
// anything it cannot prove, and writes nothing in dry-run.
// --------------------------------------------------------------------------

const run = randomUUID().slice(0, 8);
let actorId = "";
const productIds: string[] = [];

async function product(name: string) {
  const row = await prisma.product.create({
    data: { code: `INV-${run}-${productIds.length}`, orionCode: `INV${run}${productIds.length}`, name, unit: "unidad" },
  });
  productIds.push(row.id);
  return row.id;
}

async function batch(productId: string, quantity: number) {
  return prisma.productBatch.create({
    data: { productId, batchCode: `B-${randomUUID().slice(0, 6)}`, quantity, status: "DISPONIBLE" },
  });
}

async function pending(
  productId: string,
  quantity: number,
  ready: number,
  createdAt: Date,
) {
  return prisma.pending.create({
    data: {
      productId,
      quantity,
      promisedAt: new Date(Date.now() + 86_400_000),
      createdById: actorId,
      createdAt,
      inventoryReadyQuantity: ready,
      reservedInventoryQuantity: ready,
      availabilityStatus: ready === 0 ? "ESPERANDO" : ready === quantity ? "DISPONIBLE_COMPLETO" : "DISPONIBLE_PARCIAL",
    },
  });
}

/** What legacy reception left behind: allocation + reservation, batch already decremented. */
async function legacyReceptionReservation(
  pendingId: string,
  productId: string,
  batchId: string,
  quantity: number,
) {
  const at = new Date();
  const entry = await prisma.inventoryEntry.create({
    data: { productId, quantity, requestFingerprint: "legacy", createdAt: at },
  });
  const missing = await prisma.missingItem.create({
    data: { productId, quantity, receivedQuantity: quantity, originId: pendingId, status: "RECIBIDO" },
  });
  await prisma.inventoryAllocation.create({
    data: { inventoryEntryId: entry.id, missingItemId: missing.id, pendingId, quantity, createdAt: at },
  });
  return prisma.pendingInventoryReservation.create({
    data: { pendingId, batchId, quantity, createdAt: at },
  });
}

async function snapshot() {
  const [batches, reservations, pendings, audits, commands, missing] = await Promise.all([
    prisma.productBatch.findMany({ where: { productId: { in: productIds } }, orderBy: { id: "asc" } }),
    prisma.pendingInventoryReservation.findMany({ where: { batch: { productId: { in: productIds } } }, orderBy: { id: "asc" } }),
    prisma.pending.findMany({ where: { productId: { in: productIds } }, orderBy: { id: "asc" } }),
    prisma.auditLog.count({ where: { userId: actorId } }),
    prisma.operationalCommand.count({ where: { commandType: INVENTORY_INVARIANT_REPAIR_COMMAND } }),
    prisma.missingItem.findMany({ where: { productId: { in: productIds } }, orderBy: { id: "asc" } }),
  ]);
  return { batches, reservations, pendings, audits, commands, missing };
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

/**
 * The MINOXITEN incident: 2 historical units promised without a reservation,
 * then a reception of 4 allocated 3 (2 + 1) and subtracted them from the batch.
 * Physical truth 6, batch shows 3, ledger 3, promises 5.
 */
async function seedMinoxiten() {
  const productId = await product("MINOXITEN");
  const b = await batch(productId, 3);
  const a = await pending(productId, 4, 4, hoursAgo(5));
  const c = await pending(productId, 1, 1, hoursAgo(4));
  await legacyReceptionReservation(a.id, productId, b.id, 2);
  await legacyReceptionReservation(c.id, productId, b.id, 1);
  return { productId, batchId: b.id, olderId: a.id, newerId: c.id };
}

/** Two promises without reservation rows over a single physical unit. */
async function seedOverPromised() {
  const productId = await product("ARTRODAR");
  const b = await batch(productId, 1);
  const older = await pending(productId, 1, 1, hoursAgo(3));
  const newer = await pending(productId, 1, 1, hoursAgo(2));
  return { productId, batchId: b.id, olderId: older.id, newerId: newer.id };
}

beforeEach(async () => {
  actorId = (await prisma.user.create({ data: { email: `repair-${randomUUID()}@test.local`, name: "Admin" } })).id;
});

afterEach(async () => {
  await prisma.operationalCommand.deleteMany({ where: { commandType: INVENTORY_INVARIANT_REPAIR_COMMAND } });
  await prisma.pendingInventoryReservation.deleteMany({ where: { batch: { productId: { in: productIds } } } });
  await prisma.inventoryAllocation.deleteMany({ where: { missingItem: { productId: { in: productIds } } } });
  await prisma.missingItem.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.inventoryEntry.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.auditLog.deleteMany({ where: { userId: actorId } });
  await prisma.productBatch.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.pending.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  await prisma.user.deleteMany({ where: { id: actorId } });
  productIds.length = 0;
});

describe("repairInventoryInvariant · dry-run", () => {
  it("plans the restore and the claims, prints a fingerprint, and writes nothing", async () => {
    await seedMinoxiten();
    await seedOverPromised();
    const before = await snapshot();

    const report = await repairInventoryInvariant({ actorId, apply: false });

    expect(report.status).toBe("planned");
    expect(report.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(report.restores.reduce((t, r) => t + r.quantity, 0)).toBe(3);
    expect(report.blockers).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
});

describe("repairInventoryInvariant · apply", () => {
  it("restores the subtracted units and reserves the uncovered promise (MINOXITEN)", async () => {
    const s = await seedMinoxiten();
    const plan = await repairInventoryInvariant({ actorId, apply: false });

    const report = await repairInventoryInvariant({ actorId, apply: true, expectedFingerprint: plan.fingerprint });

    expect(report.status).toBe("applied");
    const b = await prisma.productBatch.findUniqueOrThrow({ where: { id: s.batchId } });
    expect(b.quantity).toBe(6);
    const reserved = async (pendingId: string) =>
      (await prisma.pendingInventoryReservation.aggregate({ where: { pendingId }, _sum: { quantity: true } }))._sum.quantity;
    expect(await reserved(s.olderId)).toBe(4);
    expect(await reserved(s.newerId)).toBe(1);
    const older = await prisma.pending.findUniqueOrThrow({ where: { id: s.olderId } });
    expect(older.inventoryReadyQuantity).toBe(4);
    expect(older.reservedInventoryQuantity).toBe(4);
    expect(older.availabilityStatus).toBe("DISPONIBLE_COMPLETO");

    const restoreAudits = await prisma.auditLog.findMany({
      where: { action: AUDIT_ACTIONS.INVENTORY_INVARIANT_RESTORE, entityId: s.batchId },
    });
    expect(restoreAudits).toHaveLength(1);
    expect(restoreAudits[0]?.before).toMatchObject({ quantity: 3 });
    expect(restoreAudits[0]?.after).toMatchObject({ quantity: 6, restoredUnits: 3 });
  });

  it("keeps the oldest promise and turns the unsupported one into a missing item", async () => {
    const s = await seedOverPromised();
    const plan = await repairInventoryInvariant({ actorId, apply: false });

    await repairInventoryInvariant({ actorId, apply: true, expectedFingerprint: plan.fingerprint });

    const older = await prisma.pending.findUniqueOrThrow({ where: { id: s.olderId } });
    const newer = await prisma.pending.findUniqueOrThrow({ where: { id: s.newerId } });
    expect(older.inventoryReadyQuantity).toBe(1);
    expect(newer.inventoryReadyQuantity).toBe(0);
    expect(newer.reservedInventoryQuantity).toBe(0);
    expect(newer.availabilityStatus).toBe("ESPERANDO");
    const missing = await prisma.missingItem.findFirst({ where: { originId: s.newerId, status: "FALTANTE" } });
    expect(missing?.quantity).toBe(1);
    // Physical stock is not invented: the batch keeps its single unit.
    expect((await prisma.productBatch.findUniqueOrThrow({ where: { id: s.batchId } })).quantity).toBe(1);
  });

  it("a replay after apply is a noop and changes nothing", async () => {
    await seedMinoxiten();
    const plan = await repairInventoryInvariant({ actorId, apply: false });
    await repairInventoryInvariant({ actorId, apply: true, expectedFingerprint: plan.fingerprint });
    const after = await snapshot();

    const replay = await repairInventoryInvariant({ actorId, apply: true, expectedFingerprint: plan.fingerprint });

    expect(replay.status).toBe("noop");
    expect(await snapshot()).toEqual(after);
  });

  it("refuses to apply without the reviewed fingerprint and writes nothing", async () => {
    await seedMinoxiten();
    const before = await snapshot();

    const missing = await repairInventoryInvariant({ actorId, apply: true });
    const wrong = await repairInventoryInvariant({ actorId, apply: true, expectedFingerprint: "0".repeat(64) });

    expect(missing.status).toBe("blocked");
    expect(wrong.status).toBe("blocked");
    expect(wrong.blockers.join(" ")).toContain("huella");
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back everything when the audit cannot be written", async () => {
    await seedMinoxiten();
    const plan = await repairInventoryInvariant({ actorId, apply: false });
    const before = await snapshot();

    await expect(
      repairInventoryInvariant(
        { actorId, apply: true, expectedFingerprint: plan.fingerprint },
        { writeAudit: () => Promise.reject(new Error("audit unavailable")) },
      ),
    ).rejects.toThrow("audit unavailable");

    expect(await snapshot()).toEqual(before);
  });
});

describe("repairInventoryInvariant · pendings without a missing item", () => {
  it("lists them for review and does not create a missing item", async () => {
    const productId = await product("ORPHAN");
    const orphan = await pending(productId, 3, 0, hoursAgo(1));
    const discarded = await pending(productId, 2, 0, hoursAgo(1));
    await prisma.missingItem.create({
      data: { productId, quantity: 2, originId: discarded.id, status: "CANCELADO", discardedAt: new Date() },
    });

    const report = await repairInventoryInvariant({ actorId, apply: false });

    expect(report.orphans).toEqual([{ pendingId: orphan.id, productId, deficit: 3 }]);
    expect(await prisma.missingItem.count({ where: { originId: orphan.id } })).toBe(0);
  });
});

describe("repairInventoryInvariant · fails closed", () => {
  it("blocks a reservation with no reception evidence", async () => {
    const productId = await product("SOFT");
    const b = await batch(productId, 2);
    const p = await pending(productId, 2, 2, hoursAgo(1));
    await prisma.pendingInventoryReservation.create({ data: { pendingId: p.id, batchId: b.id, quantity: 2 } });
    const before = await snapshot();

    const report = await repairInventoryInvariant({ actorId, apply: false });

    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toContain(p.id);
    expect(await snapshot()).toEqual(before);
  });

  it("blocks a batch that was physically adjusted after the reservation", async () => {
    const s = await seedMinoxiten();
    await prisma.auditLog.create({
      data: {
        action: AUDIT_ACTIONS.INVENTORY_ADJUST,
        module: "entradas",
        entity: "ProductBatch",
        entityId: s.batchId,
        userId: actorId,
        createdAt: new Date(Date.now() + 1000),
      },
    });

    const report = await repairInventoryInvariant({ actorId, apply: false });

    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toContain(s.batchId);
  });
});

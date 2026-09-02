import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";

const blocked = (sql: string) =>
  expect(prisma.$executeRawUnsafe(sql)).rejects.toThrow(/inventory cutover marker/i);

async function resetMarker(): Promise<void> {
  await prisma.$executeRawUnsafe(`ALTER TABLE inventory_cutovers DISABLE TRIGGER inventory_cutover_transition_guard`);
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_cutovers`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO inventory_cutovers (
      id, state, "pendingMarkedCount", "missingItemMarkedCount",
      "productBatchPreservedCount", "inventoryEntryPreservedCount",
      "inventoryAllocationPreservedCount", "pendingReservationPreservedCount",
      "migrationVersion"
    ) VALUES (1, 'PREPARED', 0, 0, 0, 0, 0, 0, 'test')`);
  await prisma.$executeRawUnsafe(`ALTER TABLE inventory_cutovers ENABLE TRIGGER inventory_cutover_transition_guard`);
}

async function clearFixtureRows(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM pending_inventory_reservations`);
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_allocations`);
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_entries`);
  await prisma.$executeRawUnsafe(`DELETE FROM product_batches`);
  await prisma.$executeRawUnsafe(`DELETE FROM missing_items`);
  await prisma.$executeRawUnsafe(`DELETE FROM pendings`);
  await prisma.$executeRawUnsafe(`DELETE FROM products WHERE id = 'cutover-product'`);
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = 'cutover-user'`);
}

async function seedLegacyRows(): Promise<void> {
  await clearFixtureRows();
  await prisma.$executeRawUnsafe(`INSERT INTO users (id, email, name, "updatedAt") VALUES ('cutover-user', 'cutover@test.invalid', 'Cutover', now())`);
  await prisma.$executeRawUnsafe(`INSERT INTO products (id, code, name, unit, "updatedAt") VALUES ('cutover-product', 'CUTOVER', 'Cutover', 'unit', now())`);
  await prisma.$executeRawUnsafe(`INSERT INTO pendings (id, "productId", quantity, "promisedAt", "legacyBeta", "updatedAt") VALUES ('pending-legacy', 'cutover-product', 1, now(), true, now()), ('pending-current', 'cutover-product', 1, now(), false, now())`);
  await prisma.$executeRawUnsafe(`INSERT INTO missing_items (id, "productId", quantity, "legacyBeta", "updatedAt") VALUES ('missing-legacy', 'cutover-product', 1, true, now()), ('missing-current', 'cutover-product', 1, false, now())`);
  await prisma.$executeRawUnsafe(`INSERT INTO product_batches (id, "productId", "batchCode", "expiresAt", quantity, "updatedAt") VALUES ('batch-legacy', 'cutover-product', 'CUTOVER', now() + interval '1 year', 1, now())`);
  await prisma.$executeRawUnsafe(`INSERT INTO inventory_entries (id, "productId", quantity, "idempotencyKey", "requestFingerprint") VALUES ('entry-legacy', 'cutover-product', 1, '00000000-0000-4000-8000-000000000249', 'test')`);
  await prisma.$executeRawUnsafe(`INSERT INTO inventory_allocations (id, "inventoryEntryId", "missingItemId", quantity) VALUES ('allocation-legacy', 'entry-legacy', 'missing-legacy', 1)`);
  await prisma.$executeRawUnsafe(`INSERT INTO pending_inventory_reservations (id, "pendingId", "batchId", quantity) VALUES ('reservation-legacy', 'pending-legacy', 'batch-legacy', 1)`);
}

async function activate(): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE inventory_cutovers SET state = 'ACTIVATED', "cutoverAt" = now(), "activatedById" = 'cutover-user' WHERE id = 1`);
}

beforeEach(async () => {
  await resetMarker();
  await seedLegacyRows();
});

afterEach(async () => {
  await resetMarker();
  await clearFixtureRows();
});

describe("inventory cutover database guard", () => {
  it("starts as exactly one PREPARED marker and only moves forward", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: number; state: string }>>(`SELECT id, state::text FROM inventory_cutovers`);
    expect(rows).toEqual([{ id: 1, state: "PREPARED" }]);
    await expect(prisma.$executeRawUnsafe(`INSERT INTO inventory_cutovers (id, state, "migrationVersion") VALUES (2, 'PREPARED', 'duplicate')`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`DELETE FROM inventory_cutovers`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`TRUNCATE inventory_cutovers`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`UPDATE inventory_cutovers SET state = 'LOCKED', "lockedAt" = now() WHERE id = 1`)).rejects.toThrow(/transition/i);
    await expect(prisma.$queryRawUnsafe(`SELECT id FROM inventory_cutovers`)).resolves.toEqual([{ id: 1 }]);

    await activate();
    await expect(prisma.$executeRawUnsafe(`UPDATE inventory_cutovers SET state = 'PREPARED' WHERE id = 1`)).rejects.toThrow(/transition/i);
    await prisma.$executeRawUnsafe(`UPDATE inventory_cutovers SET state = 'LOCKED', "lockedAt" = now() WHERE id = 1`);
    await expect(prisma.$executeRawUnsafe(`UPDATE inventory_cutovers SET state = 'ACTIVATED' WHERE id = 1`)).rejects.toThrow(/transition/i);
  });

  it("fails closed when the marker is absent, duplicated, or unknown", async () => {
    await prisma.$executeRawUnsafe(`ALTER TABLE inventory_cutovers DISABLE TRIGGER inventory_cutover_transition_guard`);
    await prisma.$executeRawUnsafe(`DELETE FROM inventory_cutovers`);
    await prisma.$executeRawUnsafe(`ALTER TABLE inventory_cutovers ENABLE TRIGGER inventory_cutover_transition_guard`);
    await blocked(`UPDATE product_batches SET quantity = quantity WHERE id = 'batch-legacy'`);

    await resetMarker();
    await prisma.$executeRawUnsafe(`ALTER TABLE inventory_cutovers DROP CONSTRAINT inventory_cutovers_singleton_check`);
    await prisma.$executeRawUnsafe(`ALTER TABLE inventory_cutovers DISABLE TRIGGER inventory_cutover_transition_guard`);
    await prisma.$executeRawUnsafe(`INSERT INTO inventory_cutovers (id, state, "migrationVersion") VALUES (2, 'PREPARED', 'duplicate')`);
    await prisma.$executeRawUnsafe(`ALTER TABLE inventory_cutovers ENABLE TRIGGER inventory_cutover_transition_guard`);
    await blocked(`UPDATE product_batches SET quantity = quantity WHERE id = 'batch-legacy'`);
    await prisma.$executeRawUnsafe(`ALTER TABLE inventory_cutovers DISABLE TRIGGER inventory_cutover_transition_guard`);
    await prisma.$executeRawUnsafe(`DELETE FROM inventory_cutovers WHERE id = 2`);
    await prisma.$executeRawUnsafe(`ALTER TABLE inventory_cutovers ENABLE TRIGGER inventory_cutover_transition_guard`);
    await prisma.$executeRawUnsafe(`ALTER TABLE inventory_cutovers ADD CONSTRAINT inventory_cutovers_singleton_check CHECK (id = 1)`);

    await prisma.$executeRawUnsafe(`ALTER TYPE "InventoryCutoverState" ADD VALUE IF NOT EXISTS 'CORRUPTED'`);
    await prisma.$executeRawUnsafe(`ALTER TABLE inventory_cutovers DISABLE TRIGGER inventory_cutover_transition_guard`);
    await prisma.$executeRawUnsafe(`UPDATE inventory_cutovers SET state = 'CORRUPTED' WHERE id = 1`);
    await prisma.$executeRawUnsafe(`ALTER TABLE inventory_cutovers ENABLE TRIGGER inventory_cutover_transition_guard`);
    await blocked(`UPDATE product_batches SET quantity = quantity WHERE id = 'batch-legacy'`);
  });

  it("blocks every write class on each legacy inventory table after activation", async () => {
    await activate();
    const cases = [
      ["product_batches", `INSERT INTO product_batches (id, "productId", "batchCode", "expiresAt", quantity, "updatedAt") VALUES ('blocked-batch', 'cutover-product', 'BLOCKED', now(), 1, now())`, `UPDATE product_batches SET quantity = 2 WHERE id = 'batch-legacy'`, `DELETE FROM product_batches WHERE id = 'batch-legacy'`],
      ["inventory_entries", `INSERT INTO inventory_entries (id, "productId", quantity, "idempotencyKey", "requestFingerprint") VALUES ('blocked-entry', 'cutover-product', 1, '00000000-0000-4000-8000-000000000250', 'test')`, `UPDATE inventory_entries SET quantity = 2 WHERE id = 'entry-legacy'`, `DELETE FROM inventory_entries WHERE id = 'entry-legacy'`],
      ["inventory_allocations", `INSERT INTO inventory_allocations (id, "inventoryEntryId", "missingItemId", quantity) VALUES ('blocked-allocation', 'entry-legacy', 'missing-legacy', 1)`, `UPDATE inventory_allocations SET quantity = 2 WHERE id = 'allocation-legacy'`, `DELETE FROM inventory_allocations WHERE id = 'allocation-legacy'`],
      ["pending_inventory_reservations", `INSERT INTO pending_inventory_reservations (id, "pendingId", "batchId", quantity) VALUES ('blocked-reservation', 'pending-legacy', 'batch-legacy', 1)`, `UPDATE pending_inventory_reservations SET quantity = 2 WHERE id = 'reservation-legacy'`, `DELETE FROM pending_inventory_reservations WHERE id = 'reservation-legacy'`],
    ] as const;
    for (const [table, insert, update, remove] of cases) {
      await blocked(insert);
      await blocked(update);
      await blocked(remove);
      await blocked(`TRUNCATE TABLE ${table} CASCADE`);
    }
  });

  it("preserves legacy Pending and MissingItem rows while allowing current rows", async () => {
    await activate();
    for (const table of ["pendings", "missing_items"] as const) {
      const prefix = table === "pendings" ? "pending" : "missing";
      const required = table === "pendings" ? `, "promisedAt"` : "";
      const values = table === "pendings" ? ", now()" : "";
      await blocked(`UPDATE ${table} SET quantity = 2 WHERE id = '${prefix}-legacy'`);
      await blocked(`DELETE FROM ${table} WHERE id = '${prefix}-legacy'`);
      await blocked(`INSERT INTO ${table} (id, "productId", quantity, "legacyBeta", "updatedAt"${required}) VALUES ('${prefix}-blocked', 'cutover-product', 1, true, now()${values})`);
      await blocked(`UPDATE ${table} SET "legacyBeta" = true WHERE id = '${prefix}-current'`);
      await prisma.$executeRawUnsafe(`INSERT INTO ${table} (id, "productId", quantity, "updatedAt"${required}) VALUES ('${prefix}-new', 'cutover-product', 1, now()${values})`);
      await prisma.$executeRawUnsafe(`UPDATE ${table} SET quantity = 2 WHERE id = '${prefix}-current'`);
      await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE id = '${prefix}-current'`);
      await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE id = '${prefix}-new'`);
      await blocked(`TRUNCATE TABLE ${table} CASCADE`);
    }
  });
});

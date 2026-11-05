import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { getSellableStock } from "@/server/services/product-batch.service";
import { adjustBatchQuantity } from "@/server/services/inventory-adjustment.service";
import { deliverPending, registerPending } from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// Concurrency of the physical-total invariant (#332, JD-A-003/JD-B-001,
// JD-A-004). Batches are created so that id order and expiry order disagree:
// any path that locks batches in its own order deadlocks against another.
// --------------------------------------------------------------------------

const ITERATIONS = 5;
let ownerId = "";
let productId = "";

beforeAll(async () => {
  const stamp = randomUUID().slice(0, 8);
  ownerId = (await prisma.user.create({ data: { email: `lock-${stamp}@test.local`, name: "Gerencia" } })).id;
  productId = (await prisma.product.create({
    data: { orionCode: `LCK${stamp}`, code: `LCK-${stamp}`, name: "Producto", unit: "unidad" },
  })).id;
});

async function cleanup() {
  await prisma.notificationOutbox.deleteMany({ where: { recipientId: ownerId } });
  await prisma.pendingInventoryReservation.deleteMany({ where: { batch: { productId } } });
  await prisma.pendingDelivery.deleteMany({ where: { pending: { productId } } });
  await prisma.missingItem.deleteMany({ where: { productId } });
  await prisma.auditLog.deleteMany({ where: { userId: ownerId } });
  await prisma.operationalCommand.deleteMany({ where: { actorId: ownerId } });
  await prisma.productBatch.deleteMany({ where: { productId } });
  await prisma.pending.deleteMany({ where: { productId } });
}

afterEach(cleanup);

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
});

/** Two lots: the first created (lower id) expires LATER than the second. */
async function invertedLots(quantity: number) {
  const later = await prisma.productBatch.create({
    data: { productId, batchCode: `LATE-${randomUUID().slice(0, 6)}`, quantity, status: "DISPONIBLE", expiresAt: new Date(Date.now() + 300 * 86_400_000) },
  });
  const sooner = await prisma.productBatch.create({
    data: { productId, batchCode: `SOON-${randomUUID().slice(0, 6)}`, quantity, status: "DISPONIBLE", expiresAt: new Date(Date.now() + 60 * 86_400_000) },
  });
  return { later, sooner };
}

/** An invoiced pending holding one unit on each lot. */
async function invoicedOnBoth(laterId: string, soonerId: string) {
  const pending = await prisma.pending.create({
    data: {
      productId,
      quantity: 2,
      promisedAt: new Date(Date.now() + 86_400_000),
      customerName: "Cliente",
      customerPhone: "3001234567",
      createdById: ownerId,
      customerStatus: "FACTURADO",
      invoicedQuantity: 2,
      inventoryReadyQuantity: 2,
      reservedInventoryQuantity: 2,
      availabilityStatus: "DISPONIBLE_COMPLETO",
    },
  });
  await prisma.pendingInventoryReservation.createMany({
    data: [
      { pendingId: pending.id, batchId: laterId, quantity: 1 },
      { pendingId: pending.id, batchId: soonerId, quantity: 1 },
    ],
  });
  return pending.id;
}

/** A transaction that holds one batch FOR UPDATE until released. */
function holdBatch(batchId: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let setPid!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => {
    setPid = resolve;
  });
  const done = prisma.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT id FROM product_batches WHERE id = ${batchId} FOR UPDATE`;
      setPid(row!.pid);
      await released;
    },
    { timeout: 30_000 },
  );
  return { pid, release, done };
}

/** Waits until `expected` sessions are blocked, directly or not, behind the holder. */
async function waitForWaiters(holderPid: number, expected: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      WITH RECURSIVE blocked AS (
        SELECT pid FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
        UNION
        SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
      )
      SELECT count(*)::bigint AS n FROM blocked
    `;
    if (Number(rows[0]?.n ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${expected} blocked sessions`);
}

function isDeadlock(result: PromiseSettledResult<unknown>): boolean {
  if (result.status !== "rejected") return false;
  const text = String((result.reason as { message?: string })?.message ?? result.reason);
  return text.includes("40P01") || text.toLowerCase().includes("deadlock");
}

async function assertInvariant() {
  const pendings = await prisma.pending.findMany({
    where: { productId, status: { notIn: ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"] } },
  });
  for (const pending of pendings) {
    const live = (await prisma.pendingInventoryReservation.aggregate({
      where: { pendingId: pending.id },
      _sum: { quantity: true },
    }))._sum.quantity ?? 0;
    expect(pending.inventoryReadyQuantity).toBe(pending.deliveredQuantity + live);
    expect(pending.reservedInventoryQuantity).toBe(live);
  }
  const batches = await prisma.productBatch.findMany({ where: { productId } });
  for (const batch of batches) {
    const reserved = (await prisma.pendingInventoryReservation.aggregate({
      where: { batchId: batch.id },
      _sum: { quantity: true },
    }))._sum.quantity ?? 0;
    expect(reserved).toBeLessThanOrEqual(batch.quantity);
  }
}

describe("orden de bloqueo de lotes", () => {
  it(`entrega y alta del mismo producto a la vez, en ${ITERATIONS} vueltas: sin deadlock`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { later, sooner } = await invertedLots(3);
      const pendingId = await invoicedOnBoth(later.id, sooner.id);

      // Forced interleaving: registration queues first on the sooner lot, then
      // delivery arrives. A delivery that locked the later lot first (id
      // order) would hold it while waiting for the sooner one, and the
      // registration would then wait for the later one: a 40P01 cycle.
      const hold = holdBatch(sooner.id);
      const holderPid = await hold.pid;
      const registration = registerPending({
        productId,
        quantity: 2,
        promisedAt: new Date(Date.now() + 86_400_000),
        customerName: "Otro",
        customerPhone: "3001234567",
        createdById: ownerId,
        idempotencyKey: randomUUID(),
      });
      await waitForWaiters(holderPid, 1);
      const delivery = deliverPending({ id: pendingId, quantity: 2, deliveredById: ownerId });
      await waitForWaiters(holderPid, 2);
      hold.release();
      await hold.done;

      const results = await Promise.allSettled([delivery, registration]);

      expect(results.filter(isDeadlock)).toHaveLength(0);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      await assertInvariant();
      await cleanup();
    }
  });

  it(`ajuste de un lote y entrega en otro a la vez, en ${ITERATIONS} vueltas: sin deadlock`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { later, sooner } = await invertedLots(3);
      const pendingId = await invoicedOnBoth(later.id, sooner.id);

      const results = await Promise.allSettled([
        adjustBatchQuantity({
          batchId: later.id,
          actorId: ownerId,
          targetQuantity: 1,
          reason: "CONTEO_FISICO",
          note: null,
          idempotencyKey: randomUUID(),
        }),
        deliverPending({ id: pendingId, quantity: 1, deliveredById: ownerId }),
      ]);

      expect(results.filter(isDeadlock)).toHaveLength(0);
      await assertInvariant();
      await cleanup();
    }
  });
});

describe("stock vendible", () => {
  it("descuenta las unidades reservadas para pendientes abiertos", async () => {
    const { later, sooner } = await invertedLots(3);
    await invoicedOnBoth(later.id, sooner.id);

    // 6 physical units, 2 reserved for the pending.
    await expect(getSellableStock(productId)).resolves.toBe(4);
  });
});

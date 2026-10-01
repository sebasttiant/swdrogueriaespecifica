import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";
import {
  registerPending,
  updatePending,
  type UpdatePendingResult,
} from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// INTERCAMBIO DE PRODUCTOS X↔Y con las dos recepciones en curso (T10).
//
// P1 es de X y se corrige a Y; P2 es de Y y se corrige a X. A la vez entra
// mercadería de X y de Y. Cambiar el producto escribe la FK `productId`, que
// toma KEY SHARE sobre el producto NUEVO; la recepción tiene su producto con
// FOR UPDATE y después bloquea los pendientes de origen. Si la corrección toma
// la FK DESPUÉS de su pendiente, se cierra un ciclo de cuatro:
//
//   R_X (tiene X) espera P1 → U1 (tiene P1) espera Y → R_Y (tiene Y) espera P2
//   → U2 (tiene P2) espera X → R_X …
//
// Se fuerza con los candados advisory de lote que la recepción toma justo
// después de su producto: cada recepción queda retenida con su producto ya
// bloqueado, las correcciones se encolan detrás, y al soltar se cruzan. Sin
// reintentos: un 40P01 es una falla.
// --------------------------------------------------------------------------

const ITERATIONS = 3;

let userId = "";
let productX = "";
let productY = "";

beforeAll(async () => {
  const stamp = randomUUID().slice(0, 8);
  userId = (
    await prisma.user.create({ data: { email: `swap-${stamp}@test.local`, name: "Swap" } })
  ).id;
  productX = (
    await prisma.product.create({
      data: { orionCode: `ORN-SX-${stamp}`, code: `SX-${stamp}`, name: "Producto X", unit: "unidad" },
    })
  ).id;
  productY = (
    await prisma.product.create({
      data: { orionCode: `ORN-SY-${stamp}`, code: `SY-${stamp}`, name: "Producto Y", unit: "unidad" },
    })
  ).id;
});

async function cleanup() {
  const products = [productX, productY];
  await prisma.notificationOutbox.deleteMany({ where: { recipientId: userId } });
  await prisma.pendingInventoryReservation.deleteMany({ where: { batch: { productId: { in: products } } } });
  await prisma.inventoryAllocation.deleteMany({ where: { missingItem: { productId: { in: products } } } });
  await prisma.missingItem.deleteMany({ where: { productId: { in: products } } });
  await prisma.inventoryEntry.deleteMany({ where: { productId: { in: products } } });
  await prisma.productBatch.deleteMany({ where: { productId: { in: products } } });
  await prisma.pending.deleteMany({ where: { productId: { in: products } } });
}

afterEach(cleanup);

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: { in: [productX, productY] } } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

async function pendingOf(productId: string) {
  const { pending, missingItem } = await registerPending({
    productId,
    quantity: 5,
    promisedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    customerName: "Cliente",
    customerPhone: "3001234567",
    createdById: userId,
    idempotencyKey: randomUUID(),
  });
  expect(missingItem?.status).toBe("FALTANTE");
  return pending.id;
}

function receive(productId: string, batchCode: string) {
  return registerInventoryEntry({
    productId,
    quantity: 5,
    batchCode,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    createdById: userId,
    idempotencyKey: randomUUID(),
  });
}

type Actor = "manager" | "restricted";

async function changeProduct(pendingId: string, productId: string, actor: Actor) {
  const row = await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } });
  return updatePending({
    id: pendingId,
    productId,
    quantity: row.quantity,
    promisedAt: row.promisedAt,
    ...(actor === "manager"
      ? {
          protectedFields: {
            state: "valid" as const,
            values: { customerName: "Cliente", customerPhone: "3001234567" },
          },
          actorId: "gerencia",
          canManageAll: true,
          canEditAll: true,
          canOrder: true,
        }
      : {
          protectedFields: { state: "absent" as const },
          actorId: "bodega-ajena",
          canManageAll: false,
          canEditAll: true,
          canOrder: false,
        }),
    manualSellerNameSent: false,
    expectedUpdatedAt: row.updatedAt,
  });
}

// Retiene el candado advisory del lote `(productId, batchCode)`, el mismo que
// toma `lockBatchForEntry` inmediatamente después de bloquear el producto.
function holdBatchLock(productId: string, batchCode: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let setPid!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => {
    setPid = resolve;
  });
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const done = prisma.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      setPid(row!.pid);
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(length(${productId})::text || ':' || ${productId} || ':' || ${batchCode}, 0)
        )
      `;
      acquired();
      await released;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  return { ready, release, done, pid };
}

// Sesiones bloqueadas, directa o transitivamente, por el holder de este test.
async function blockedBehind(holderPid: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    WITH RECURSIVE blocked AS (
      SELECT pid FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
      UNION
      SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
    )
    SELECT count(*)::bigint AS n FROM blocked
  `;
  return Number(rows[0]?.n ?? 0);
}

async function waitBlocked(hold: { pid: Promise<number> }, expected: number) {
  const holderPid = await hold.pid;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await blockedBehind(holderPid)) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: esperaba ${expected} sesiones detrás del candado del test`);
}

async function waitFor(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timeout esperando la condición");
}

function isDeadlock(reason: unknown): boolean {
  const text = String((reason as { message?: string })?.message ?? reason);
  return text.includes("40P01") || text.toLowerCase().includes("deadlock");
}

async function assertInvariants(pendingIds: string[]) {
  for (const pendingId of pendingIds) {
    const pending = await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } });
    const reservations = await prisma.pendingInventoryReservation.findMany({
      where: { pendingId },
      include: { batch: { select: { productId: true } } },
    });
    for (const reservation of reservations) expect(reservation.batch.productId).toBe(pending.productId);
    expect(pending.inventoryReadyQuantity).toBe(reservations.reduce((t, r) => t + r.quantity, 0));
  }
  for (const productId of [productX, productY]) {
    const [received, shelf, reserved, delivered] = await Promise.all([
      prisma.inventoryEntry.aggregate({ where: { productId }, _sum: { quantity: true } }),
      prisma.productBatch.aggregate({ where: { productId }, _sum: { quantity: true } }),
      prisma.pendingInventoryReservation.aggregate({ where: { batch: { productId } }, _sum: { quantity: true } }),
      prisma.pendingDelivery.aggregate({ where: { pending: { productId } }, _sum: { quantity: true } }),
    ]);
    expect(
      (shelf._sum.quantity ?? 0) + (reserved._sum.quantity ?? 0) + (delivered._sum.quantity ?? 0),
    ).toBe(received._sum.quantity ?? 0);
  }
}

describe.each(["manager", "restricted"] as const)("intercambio X↔Y (%s) con dos recepciones", (actor) => {
  it(`ciclo de cuatro forzado, en ${ITERATIONS} vueltas: sin deadlock y con invariantes`, async () => {
    let deadlocks = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const p1 = await pendingOf(productX);
      const p2 = await pendingOf(productY);
      const codeX = `SWX-${randomUUID().slice(0, 8)}`;
      const codeY = `SWY-${randomUUID().slice(0, 8)}`;

      // R_Y queda con Y bloqueado y retenida en su lote; U1 (P1: X→Y) se encola.
      const holdY = holdBatchLock(productY, codeY);
      await holdY.ready;
      const receptionY = receive(productY, codeY);
      await waitBlocked(holdY, 1);
      const u1 = changeProduct(p1, productY, actor);
      await waitBlocked(holdY, 2);

      // R_X queda con X bloqueado y retenida en su lote; U2 (P2: Y→X) se encola.
      const holdX = holdBatchLock(productX, codeX);
      await holdX.ready;
      const receptionX = receive(productX, codeX);
      await waitBlocked(holdX, 1);
      const u2 = changeProduct(p2, productX, actor);
      await waitBlocked(holdX, 2);

      // Se suelta X. Con el orden viejo R_X queda esperando P1 (que tiene U1) y
      // detrás de Y se apilan R_Y, U1, R_X y U2. Con el orden corregido U1 nunca
      // tomó P1: R_X termina, y U2 —que esperaba X sin tener P2— también.
      const settled = { receptionX: false, u2: false };
      void receptionX.then(() => (settled.receptionX = true), () => (settled.receptionX = true));
      void u2.then(() => (settled.u2 = true), () => (settled.u2 = true));
      holdX.release();
      await holdX.done;
      await waitFor(
        async () =>
          (settled.receptionX && settled.u2) || (await blockedBehind(await holdY.pid)) >= 3,
      );
      // Se suelta Y: R_Y avanza hasta P2 y, con el orden viejo, cierra el ciclo.
      holdY.release();
      await holdY.done;

      const results = await Promise.allSettled([receptionX, receptionY, u1, u2]);
      for (const result of results) {
        if (result.status === "rejected" && isDeadlock(result.reason)) deadlocks += 1;
      }
      for (const result of results) expect(result.status).toBe("fulfilled");
      const [, , r1, r2] = results as [
        PromiseSettledResult<unknown>,
        PromiseSettledResult<unknown>,
        PromiseSettledResult<UpdatePendingResult>,
        PromiseSettledResult<UpdatePendingResult>,
      ];
      // Orden corregido, resultado determinado:
      //  - R_X le asignó las 5 a P1 (U1 todavía no tenía P1);
      //  - U2 cambió P2 a X antes de que R_Y llegara a P2 (P2 no tenía stock);
      //  - R_Y ya no encontró el faltante de P2 (cancelado) y no asignó nada;
      //  - U1 decidió después: gerencia trae el testigo viejo (STALE) y la
      //    restringida ve el stock asignado (PRODUCT_LOCKED_SUPPLY).
      if (r2.status === "fulfilled") expect(r2.value.rejection).toBeNull();
      if (r1.status === "fulfilled") {
        expect(r1.value.rejection).toBe(actor === "manager" ? "STALE" : "PRODUCT_LOCKED_SUPPLY");
      }
      const row1 = await prisma.pending.findUniqueOrThrow({ where: { id: p1 } });
      const row2 = await prisma.pending.findUniqueOrThrow({ where: { id: p2 } });
      expect(row1.productId).toBe(productX);
      expect(row1.inventoryReadyQuantity).toBe(5);
      expect(row2.productId).toBe(productX);
      expect(row2.inventoryReadyQuantity).toBe(0);
      await assertInvariants([p1, p2]);
      await cleanup();
    }
    expect(deadlocks).toBe(0);
  });
});

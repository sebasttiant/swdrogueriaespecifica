import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { markMissingItemArrived } from "@/server/repositories/missing-item.repository";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";
import {
  registerPending,
  updatePending,
  type UpdatePendingResult,
} from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// CAMBIO DE PRODUCTO contra RECEPCIÓN, a la vez, en PostgreSQL real (T6).
//
// Una corrección que cambia el producto de un pendiente P cancela el faltante
// que P originó y suelta sus reservas. La recepción de mercadería del producto
// VIEJO asigna esa mercadería al mismo faltante, le sube el stock a P y le
// reserva lotes. Si las dos se cruzan, lo que no puede pasar es:
//
//   - que P termine con reservas de lotes del producto viejo;
//   - que unidades recibidas desaparezcan (ni en el estante ni reservadas);
//   - que el stock asignado a P no coincida con sus reservas vivas.
//
// Las intercalaciones se FUERZAN con una transacción que retiene un candado y
// se suelta cuando las dos operaciones reales ya están esperando, observadas en
// `pg_stat_activity`. Sin eso, "correr en paralelo" casi nunca cae en la
// ventana que importa y el test pasaría por suerte.
// --------------------------------------------------------------------------

const ITERATIONS = 5;
const RANDOM_ITERATIONS = 20;

let ownerId = "";
let editorId = "";
let productA = "";
let productB = "";

beforeAll(async () => {
  const stamp = randomUUID().slice(0, 8);
  const [owner, editor] = await Promise.all([
    prisma.user.create({ data: { email: `race-owner-${stamp}@test.local`, name: "Dueña" } }),
    prisma.user.create({ data: { email: `race-editor-${stamp}@test.local`, name: "Bodega" } }),
  ]);
  ownerId = owner.id;
  editorId = editor.id;
  const [a, b] = await Promise.all([
    prisma.product.create({
      data: { orionCode: `ORN-RA-${stamp}`, code: `RA-${stamp}`, name: "Producto A", unit: "unidad" },
    }),
    prisma.product.create({
      data: { orionCode: `ORN-RB-${stamp}`, code: `RB-${stamp}`, name: "Producto B", unit: "unidad" },
    }),
  ]);
  productA = a.id;
  productB = b.id;
});

afterEach(async () => {
  const products = [productA, productB];
  await prisma.notificationOutbox.deleteMany({ where: { recipientId: { in: [ownerId, editorId] } } });
  await prisma.pendingInventoryReservation.deleteMany({
    where: { batch: { productId: { in: products } } },
  });
  await prisma.inventoryAllocation.deleteMany({
    where: { missingItem: { productId: { in: products } } },
  });
  await prisma.missingItem.deleteMany({ where: { productId: { in: products } } });
  await prisma.inventoryEntry.deleteMany({ where: { productId: { in: products } } });
  await prisma.productBatch.deleteMany({ where: { productId: { in: products } } });
  await prisma.pending.deleteMany({ where: { productId: { in: products } } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: { in: [productA, productB] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, editorId] } } });
});

// P, del producto A, sin stock: nace con un faltante FALTANTE por las 5.
async function pendingWithoutStock(quantity = 5) {
  const { pending, missingItem } = await registerPending({
    productId: productA,
    quantity,
    promisedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    customerName: "Cliente",
    customerPhone: "3001234567",
    createdById: ownerId,
    idempotencyKey: randomUUID(),
  });
  expect(missingItem?.status).toBe("FALTANTE");
  return { pendingId: pending.id, missingItemId: missingItem!.id };
}

function receiveA(quantity: number) {
  return registerInventoryEntry({
    productId: productA,
    quantity,
    batchCode: `L-${randomUUID().slice(0, 8)}`,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    createdById: editorId,
    idempotencyKey: randomUUID(),
  });
}

type Actor = "restricted" | "manager" | "own";

async function changeProduct(pendingId: string, actor: Actor): Promise<UpdatePendingResult> {
  const row = await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } });
  return updatePending({
    id: pendingId,
    productId: productB,
    quantity: row.quantity,
    promisedAt: row.promisedAt,
    note: "cambio de producto",
    ...(actor === "restricted"
      ? {
          protectedFields: { state: "absent" as const },
          manualSellerNameSent: false,
          actorId: editorId,
          canManageAll: false,
          canEditAll: true,
          canOrder: false,
        }
      : {
          protectedFields: {
            state: "valid" as const,
            values: { customerName: row.customerName ?? "Cliente", customerPhone: row.customerPhone ?? "3001234567" },
          },
          manualSellerNameSent: false,
          // Gerencia corrige cualquiera; el dueño con `canEditAllPendings`
          // corrige el suyo con todos los campos (no es restringida).
          actorId: actor === "own" ? ownerId : editorId,
          canManageAll: actor === "manager",
          canEditAll: true,
          // Gerencia (ADMIN) tiene autoridad de compras; el dueño vendedor no.
          canOrder: actor === "manager",
        }),
    expectedUpdatedAt: row.updatedAt,
  });
}

// Cuántas sesiones están bloqueadas, directa o transitivamente, por la
// transacción que retiene el candado de ESTE test. Se sigue el árbol de
// `pg_blocking_pids` desde su pid: cualquier otra sesión de la base —otro test,
// una conexión ociosa del pool— no cuenta.
async function lockWaiters(holderPid: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    WITH RECURSIVE blocked AS (
      SELECT pid FROM pg_stat_activity
       WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
      UNION
      SELECT a.pid FROM pg_stat_activity a
        JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
    )
    SELECT count(*)::bigint AS n FROM blocked
  `;
  return Number(rows[0]?.n ?? 0);
}

async function waitForLockWaiters(hold: { pid: Promise<number> }, expected: number): Promise<void> {
  const holderPid = await hold.pid;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await lockWaiters(holderPid)) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: esperaba ${expected} sesiones bloqueadas detrás del candado del test`);
}

/**
 * Una transacción que retiene un candado hasta que se la suelta. Devuelve la
 * función que la suelta y la promesa de su fin.
 */
function holdLock(sql: (tx: typeof prisma) => Promise<unknown>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  let holderPid!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => {
    holderPid = resolve;
  });
  const done = prisma.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      holderPid(row!.pid);
      await sql(tx as unknown as typeof prisma);
      acquired();
      await released;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  return { ready, release, done, pid };
}

function isDeadlock(reason: unknown): boolean {
  const text = String((reason as { message?: string })?.message ?? reason);
  return text.includes("40P01") || text.toLowerCase().includes("deadlock");
}

type Settled = { reception: PromiseSettledResult<unknown>; update: PromiseSettledResult<UpdatePendingResult> };

// Las invariantes que ninguna intercalación puede romper.
async function assertInvariants(pendingId: string) {
  const pending = await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } });
  const reservations = await prisma.pendingInventoryReservation.findMany({
    where: { pendingId },
    include: { batch: { select: { productId: true } } },
  });

  // 1. Ninguna reserva de P apunta a lotes de un producto que P ya no tiene.
  for (const reservation of reservations) {
    expect(reservation.batch.productId).toBe(pending.productId);
  }

  // 2. El stock asignado a P es exactamente lo que tiene reservado vivo.
  const reserved = reservations.reduce((total, r) => total + r.quantity, 0);
  expect(pending.inventoryReadyQuantity).toBe(reserved);

  // 3. Conservación, por producto: lo recibido está en el estante, reservado o
  //    entregado. Nunca desaparece. (Las entregas consumen reservas sin tocar el
  //    lote; estos escenarios no entregan, pero el término va igual.)
  for (const productId of [productA, productB]) {
    const [received, shelf, reservedHere, delivered] = await Promise.all([
      prisma.inventoryEntry.aggregate({ where: { productId }, _sum: { quantity: true } }),
      prisma.productBatch.aggregate({ where: { productId }, _sum: { quantity: true } }),
      prisma.pendingInventoryReservation.aggregate({
        where: { batch: { productId } },
        _sum: { quantity: true },
      }),
      prisma.pendingDelivery.aggregate({ where: { pending: { productId } }, _sum: { quantity: true } }),
    ]);
    expect(
      (shelf._sum.quantity ?? 0) + (reservedHere._sum.quantity ?? 0) + (delivered._sum.quantity ?? 0),
    ).toBe(received._sum.quantity ?? 0);
  }
}

// Qué responde una corrección que llega DESPUÉS de una recepción que le asignó
// stock a P: la restringida ve abastecimiento en curso; el dueño sin autoridad
// de compras, mercadería apartada (contención T9); gerencia, el testigo viejo.
function rejectionAfterReception(actor: Actor) {
  if (actor === "restricted") return "PRODUCT_LOCKED_SUPPLY";
  if (actor === "own") return "PRODUCT_LOCKED_STOCK";
  return "STALE";
}

function markArrived(missingItemId: string) {
  return prisma.$transaction((tx) =>
    markMissingItemArrived(tx, { id: missingItemId, arrivedById: editorId, arrivedAt: new Date() }),
  );
}

describe.each(["restricted", "manager", "own"] as const)("cambio de producto (%s) contra recepción", (actor) => {
  // La corrección toma P y espera el faltante; la recepción espera el mismo
  // faltante detrás. Cuando se suelta, la corrección cancela el faltante y la
  // recepción ya no lo encuentra.
  it(`corrección primero, en ${ITERATIONS} vueltas: la recepción no le asigna nada a P`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { pendingId, missingItemId } = await pendingWithoutStock();
      const hold = holdLock((tx) =>
        tx.$queryRaw`SELECT id FROM missing_items WHERE id = ${missingItemId} FOR UPDATE`,
      );
      await hold.ready;

      const update = changeProduct(pendingId, actor);
      await waitForLockWaiters(hold, 1);
      const reception = receiveA(5);
      await waitForLockWaiters(hold, 2);
      hold.release();
      await hold.done;

      const [r, u] = await Promise.allSettled([reception, update]);
      expect(u.status).toBe("fulfilled");
      expect(r.status).toBe("fulfilled");
      if (u.status === "fulfilled") expect(u.value.rejection).toBeNull();
      const row = await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } });
      expect(row.productId).toBe(productB);
      await assertInvariants(pendingId);
      await cleanup();
    }
  });

  // La recepción toma el faltante primero y la corrección espera P detrás de
  // ella: ver el stock ya asignado bloquea la corrección restringida.
  it(`recepción primero, en ${ITERATIONS} vueltas: nunca hay reservas del producto viejo`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { pendingId } = await pendingWithoutStock();
      const hold = holdLock((tx) =>
        tx.$queryRaw`SELECT id FROM pendings WHERE id = ${pendingId} FOR UPDATE`,
      );
      await hold.ready;

      const reception = receiveA(5);
      await waitForLockWaiters(hold, 1);
      const update = changeProduct(pendingId, actor);
      await waitForLockWaiters(hold, 2);
      hold.release();
      await hold.done;

      const [r, u] = await Promise.allSettled([reception, update]);
      expect(r.status).toBe("fulfilled");
      expect(u.status).toBe("fulfilled");
      // La restringida ve el stock asignado y se bloquea. Gerencia abrió el
      // formulario antes de la recepción: su testigo quedó viejo y se rechaza,
      // así que tampoco suelta la reserva recién hecha.
      if (u.status === "fulfilled") {
        expect(u.value.rejection).toBe(rejectionAfterReception(actor));
      }
      expect((await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } })).productId).toBe(productA);
      await assertInvariants(pendingId);
      await cleanup();
    }
  });

  // La intercalación que daba 40P01 con el orden viejo (recepción: faltante →
  // pendiente; corrección: pendiente → faltante). Se retiene el faltante: la
  // recepción entra primero y la corrección después. Con el orden corregido
  // (pendientes ANTES que faltantes) la recepción ya tiene P cuando espera el
  // faltante, y la corrección queda esperando P detrás: no hay ciclo posible.
  // La sincronización es la misma que reproducía el deadlock, a propósito.
  it(`cruce de candados, en ${ITERATIONS} vueltas: sin deadlock y con invariantes`, async () => {
    const outcomes: Settled[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { pendingId, missingItemId } = await pendingWithoutStock();
      const hold = holdLock((tx) =>
        tx.$queryRaw`SELECT id FROM missing_items WHERE id = ${missingItemId} FOR UPDATE`,
      );
      await hold.ready;

      const reception = receiveA(5);
      await waitForLockWaiters(hold, 1);
      const update = changeProduct(pendingId, actor);
      await waitForLockWaiters(hold, 2);
      hold.release();
      await hold.done;

      const [r, u] = await Promise.allSettled([reception, update]);
      outcomes.push({ reception: r, update: u });
      expect(r.status).toBe("fulfilled");
      expect(u.status).toBe("fulfilled");
      // La recepción retiene P antes de esperar el faltante. La corrección
      // leyó su versión anterior y solo puede decidir después de la recepción.
      if (r.status === "fulfilled") {
        expect(r.value.idempotent).toBe(false);
        expect(r.value.allocatedMissingCount).toBe(1);
        expect(r.value.closedMissingCount).toBe(1);
      }
      if (u.status === "fulfilled") {
        expect(u.value.rejection).toBe(rejectionAfterReception(actor));
        expect(u.value.outcome).toBeUndefined();
      }
      expect((await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } })).productId).toBe(productA);
      await assertInvariants(pendingId);
      await cleanup();
    }

    const deadlocks = outcomes.filter(
      (o) =>
        (o.reception.status === "rejected" && isDeadlock(o.reception.reason)) ||
        (o.update.status === "rejected" && isDeadlock(o.update.reason)),
    ).length;
    expect(deadlocks).toBe(0);
  });

  it(`sin forzar, en ${RANDOM_ITERATIONS} vueltas: invariantes y sin deadlock`, async () => {
    let deadlocks = 0;
    for (let i = 0; i < RANDOM_ITERATIONS; i += 1) {
      const { pendingId } = await pendingWithoutStock();
      const [r, u] = await Promise.allSettled([receiveA(5), changeProduct(pendingId, actor)]);
      if ((r.status === "rejected" && isDeadlock(r.reason)) || (u.status === "rejected" && isDeadlock(u.reason))) {
        deadlocks += 1;
      }
      expect(r.status).toBe("fulfilled");
      expect(u.status).toBe("fulfilled");
      if (r.status === "fulfilled") expect(r.value.idempotent).toBe(false);
      if (u.status === "fulfilled") {
        // Corrección primero: UPDATED. Recepción primero: la restringida ve
        // abastecimiento; gerencia/dueño rechazan el testigo viejo como STALE.
        // Si estos últimos leyeron DESPUÉS de la recepción, también pueden
        // actualizar: las invariantes de abajo siguen exigiendo conservar stock.
        const afterReception = rejectionAfterReception(actor);
        // El dueño que leyó DESPUÉS de la recepción ya no actualiza: la
        // contención T9 lo frena con PRODUCT_LOCKED_STOCK aun con testigo fresco.
        expect([null, afterReception, ...(actor === "own" ? ["STALE"] : [])]).toContain(u.value.rejection);
        expect(u.value.outcome).toBe(u.value.rejection === null ? "UPDATED" : undefined);
        expect((await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } })).productId).toBe(
          u.value.rejection === null ? productB : productA,
        );
      }
      await assertInvariants(pendingId);
      await cleanup();
    }
    expect(deadlocks).toBe(0);
  });
});

// --------------------------------------------------------------------------
// "Ya llegó" (markMissingItemArrived) contra el cambio de producto. Mismo par
// de candados que la recepción: faltante y pendiente.
// --------------------------------------------------------------------------
describe.each(["restricted", "manager", "own"] as const)("cambio de producto (%s) contra 'ya llegó'", (actor) => {
  it(`cruce de candados, en ${ITERATIONS} vueltas: sin deadlock`, async () => {
    const outcomes: Array<{ a: PromiseSettledResult<number>; u: PromiseSettledResult<UpdatePendingResult> }> = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { pendingId, missingItemId } = await pendingWithoutStock();
      const hold = holdLock((tx) =>
        tx.$queryRaw`SELECT id FROM missing_items WHERE id = ${missingItemId} FOR UPDATE`,
      );
      await hold.ready;

      const arrival = markArrived(missingItemId);
      await waitForLockWaiters(hold, 1);
      const update = changeProduct(pendingId, actor);
      await waitForLockWaiters(hold, 2);
      hold.release();
      await hold.done;

      const [a, u] = await Promise.allSettled([arrival, update]);
      outcomes.push({ a, u });
      expect(a.status).toBe("fulfilled");
      expect(u.status).toBe("fulfilled");
      // Llegó primero: el faltante quedó EN_BODEGA y P cambió de estado. La
      // restringida lo ve como compra en curso; las otras, con el testigo viejo.
      if (u.status === "fulfilled") {
        expect(u.value.rejection).toBe(actor === "restricted" ? "PRODUCT_LOCKED_SUPPLY" : "STALE");
      }
      await assertInvariants(pendingId);
      await cleanup();
    }
    const deadlocks = outcomes.filter(
      (o) => (o.a.status === "rejected" && isDeadlock(o.a.reason)) || (o.u.status === "rejected" && isDeadlock(o.u.reason)),
    ).length;
    expect(deadlocks).toBe(0);
  });

  it(`corrección primero, en ${ITERATIONS} vueltas: la llegada ya no marca un faltante cancelado`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { pendingId, missingItemId } = await pendingWithoutStock();
      const hold = holdLock((tx) =>
        tx.$queryRaw`SELECT id FROM pendings WHERE id = ${pendingId} FOR UPDATE`,
      );
      await hold.ready;

      const update = changeProduct(pendingId, actor);
      await waitForLockWaiters(hold, 1);
      const arrival = markArrived(missingItemId);
      await waitForLockWaiters(hold, 2);
      hold.release();
      await hold.done;

      const [a, u] = await Promise.allSettled([arrival, update]);
      expect(u.status).toBe("fulfilled");
      expect(a.status).toBe("fulfilled");
      if (u.status === "fulfilled") expect(u.value.rejection).toBeNull();
      if (a.status === "fulfilled") expect(a.value).toBe(0);
      const missing = await prisma.missingItem.findUniqueOrThrow({ where: { id: missingItemId } });
      expect(missing.status).toBe("CANCELADO");
      await assertInvariants(pendingId);
      await cleanup();
    }
  });
});

// "OK gerencia": un FALTANTE con `confirmedAt` ya se pidió. La corrección de
// una fila ajena no puede cambiar el producto y cancelar esa compra.
describe("faltante con OK gerencia", () => {
  it("bloquea el cambio de producto restringido y deja el faltante intacto", async () => {
    const { pendingId, missingItemId } = await pendingWithoutStock();
    await prisma.missingItem.update({
      where: { id: missingItemId },
      data: { confirmedAt: new Date(), confirmedById: editorId },
    });

    const result = await changeProduct(pendingId, "restricted");

    expect(result.rejection).toBe("PRODUCT_LOCKED_SUPPLY");
    const missing = await prisma.missingItem.findUniqueOrThrow({ where: { id: missingItemId } });
    expect(missing.status).toBe("FALTANTE");
    expect((await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } })).productId).toBe(productA);
    await cleanup();
  });
});

// --------------------------------------------------------------------------
// La ventana entre bloquear los pendientes y bloquear los faltantes. La
// recepción tiene el producto con FOR UPDATE desde el principio, y cualquier
// fila nueva que lo referencie (un pendiente o un faltante) necesita un KEY
// SHARE sobre ese producto: no puede nacer mientras la recepción corre. Este
// test lo comprueba metiendo un alta de pendiente justo en esa ventana.
// --------------------------------------------------------------------------
describe("ventana entre pendientes y faltantes de la recepción", () => {
  it(`un pendiente nuevo del mismo producto espera a la recepción, en ${ITERATIONS} vueltas`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { pendingId } = await pendingWithoutStock();
      // Retener P deja a la recepción DENTRO de la ventana: ya tiene producto y
      // lote, y espera los pendientes antes de mirar los faltantes.
      const hold = holdLock((tx) =>
        tx.$queryRaw`SELECT id FROM pendings WHERE id = ${pendingId} FOR UPDATE`,
      );
      await hold.ready;

      // Entran 10: el doble de lo que P necesita. Si el pendiente tardío se
      // colara en la ventana, su faltante estaría entre los candidatos y se
      // llevaría parte del sobrante. Que no reciba nada discrimina por sí solo,
      // sin depender de cuánto se esperó.
      const reception = receiveA(10);
      await waitForLockWaiters(hold, 1);
      const late = pendingWithoutStock(8);
      await waitForLockWaiters(hold, 2);
      hold.release();
      await hold.done;

      const [r, l] = await Promise.allSettled([reception, late]);
      expect(r.status).toBe("fulfilled");
      expect(l.status).toBe("fulfilled");
      if (r.status !== "fulfilled" || l.status !== "fulfilled") throw new Error("unreachable");

      // La entrada se repartió SOLO a P, y por lo que P pedía.
      const allocations = await prisma.inventoryAllocation.findMany({
        where: { missingItem: { productId: productA } },
      });
      expect(allocations.map((a) => a.pendingId)).toEqual([pendingId]);
      expect(allocations.reduce((total, a) => total + a.quantity, 0)).toBe(5);

      // El tardío nació DESPUÉS de la entrada y su faltante no recibió nada de
      // ella, aunque sobraron 5 en el estante. (El alta no las ve libres: el
      // reparto de stock descuenta `inventoryReadyQuantity` de P, que la
      // recepción ya sacó del lote; ese doble descuento es previo y ajeno a
      // este test, que solo mira que el tardío no entre en la ventana.)
      const entry = await prisma.inventoryEntry.findUniqueOrThrow({ where: { id: r.value.entry.id } });
      const lateMissing = await prisma.missingItem.findUniqueOrThrow({
        where: { id: l.value.missingItemId },
      });
      expect(lateMissing.createdAt.getTime()).toBeGreaterThanOrEqual(entry.createdAt.getTime());
      expect(lateMissing.receivedQuantity).toBe(0);
      expect(
        await prisma.inventoryAllocation.count({ where: { missingItemId: l.value.missingItemId } }),
      ).toBe(0);

      // Conservación del producto: 10 recibidas = 5 en el estante + 5 reservadas.
      await assertInvariants(l.value.pendingId);
      await assertInvariants(pendingId);
      await cleanup();
    }
  });
});

async function cleanup() {
  const products = [productA, productB];
  await prisma.notificationOutbox.deleteMany({ where: { recipientId: { in: [ownerId, editorId] } } });
  await prisma.pendingInventoryReservation.deleteMany({
    where: { batch: { productId: { in: products } } },
  });
  await prisma.inventoryAllocation.deleteMany({
    where: { missingItem: { productId: { in: products } } },
  });
  await prisma.missingItem.deleteMany({ where: { productId: { in: products } } });
  await prisma.inventoryEntry.deleteMany({ where: { productId: { in: products } } });
  await prisma.productBatch.deleteMany({ where: { productId: { in: products } } });
  await prisma.pending.deleteMany({ where: { productId: { in: products } } });
}

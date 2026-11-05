import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { registerPending, updatePending } from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// Correcting a pending's product must leave it exactly as if it had been
// registered for the new product: stock already on the shelf is reserved per
// batch and the deficit becomes a missing item linked to the pending.
//
// Before #332 the correction released everything and left the pending in
// ESPERANDO with no reservation and no missing item. Reception only allocates
// to pendings that own an open missing item, so the pending became invisible
// to the warehouse while the seller saw it waiting forever.
// --------------------------------------------------------------------------

let ownerId = "";
let productA = "";
let productB = "";

beforeAll(async () => {
  const stamp = randomUUID().slice(0, 8);
  ownerId = (await prisma.user.create({ data: { email: `chg-${stamp}@test.local`, name: "Gerencia" } })).id;
  productA = (await prisma.product.create({
    data: { orionCode: `CHA${stamp}`, code: `CHA-${stamp}`, name: "Producto A", unit: "unidad" },
  })).id;
  productB = (await prisma.product.create({
    data: { orionCode: `CHB${stamp}`, code: `CHB-${stamp}`, name: "Producto B", unit: "unidad" },
  })).id;
});

afterEach(async () => {
  const products = [productA, productB];
  await prisma.pendingInventoryReservation.deleteMany({ where: { batch: { productId: { in: products } } } });
  await prisma.missingItem.deleteMany({ where: { productId: { in: products } } });
  await prisma.productBatch.deleteMany({ where: { productId: { in: products } } });
  await prisma.pending.deleteMany({ where: { productId: { in: products } } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: { in: [productA, productB] } } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
});

async function pendingOnA(quantity: number) {
  const { pending } = await registerPending({
    productId: productA,
    quantity,
    promisedAt: new Date(Date.now() + 86_400_000),
    customerName: "Cliente",
    customerPhone: "3001234567",
    createdById: ownerId,
    idempotencyKey: randomUUID(),
  });
  return prisma.pending.findUniqueOrThrow({ where: { id: pending.id } });
}

function changeToB(pending: Awaited<ReturnType<typeof pendingOnA>>) {
  return updatePending({
    id: pending.id,
    productId: productB,
    quantity: pending.quantity,
    promisedAt: pending.promisedAt,
    protectedFields: { state: "valid", values: { customerName: "Cliente", customerPhone: "3001234567" } },
    manualSellerNameSent: false,
    expectedUpdatedAt: pending.updatedAt,
    actorId: "gerencia",
    canManageAll: true,
    canEditAll: true,
    canOrder: true,
  });
}

async function reservedFor(pendingId: string, productId: string) {
  const sum = await prisma.pendingInventoryReservation.aggregate({
    where: { pendingId, batch: { productId } },
    _sum: { quantity: true },
  });
  return sum._sum.quantity ?? 0;
}

describe("corregir el producto de un pendiente", () => {
  it("reserva el stock del producto nuevo y crea el faltante por la diferencia", async () => {
    await prisma.productBatch.create({
      data: { productId: productB, batchCode: "B-1", quantity: 3, status: "DISPONIBLE" },
    });
    const pending = await pendingOnA(5);

    const result = await changeToB(pending);

    expect(result.rejection).toBeNull();
    const after = await prisma.pending.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.productId).toBe(productB);
    expect(after.inventoryReadyQuantity).toBe(3);
    expect(after.reservedInventoryQuantity).toBe(3);
    expect(after.availabilityStatus).toBe("DISPONIBLE_PARCIAL");
    expect(await reservedFor(pending.id, productB)).toBe(3);

    const open = await prisma.missingItem.findMany({
      where: { originId: pending.id, status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] } },
    });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ productId: productB, quantity: 2 });
    // The batch keeps its physical total.
    expect((await prisma.productBatch.findFirstOrThrow({ where: { productId: productB } })).quantity).toBe(3);
  });

  it("sin stock del producto nuevo queda esperando con un faltante por todo", async () => {
    const pending = await pendingOnA(4);

    await changeToB(pending);

    const after = await prisma.pending.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.inventoryReadyQuantity).toBe(0);
    expect(after.availabilityStatus).toBe("ESPERANDO");
    const open = await prisma.missingItem.findMany({
      where: { originId: pending.id, status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] } },
    });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ productId: productB, quantity: 4 });
  });

  it("no le quita stock a otro pendiente del producto nuevo", async () => {
    await prisma.productBatch.create({
      data: { productId: productB, batchCode: "B-2", quantity: 2, status: "DISPONIBLE" },
    });
    const { pending: holder } = await registerPending({
      productId: productB,
      quantity: 2,
      promisedAt: new Date(Date.now() + 86_400_000),
      customerName: "Otro",
      customerPhone: "3001234567",
      createdById: ownerId,
      idempotencyKey: randomUUID(),
    });
    const pending = await pendingOnA(2);

    await changeToB(pending);

    expect(await reservedFor(holder.id, productB)).toBe(2);
    expect(await reservedFor(pending.id, productB)).toBe(0);
    const after = await prisma.pending.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.inventoryReadyQuantity).toBe(0);
  });
});

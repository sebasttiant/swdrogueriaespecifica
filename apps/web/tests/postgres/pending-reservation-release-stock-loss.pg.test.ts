import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";
import {
  cancelPendingCommitment,
  registerPending,
  updatePending,
} from "@/server/services/pending.service";

// Canonical invariant: a batch stores the physical total while a reservation
// commits only a subset. Releasing the commitment never changes the batch;
// delivery consumes both in the same transaction.

let ownerId = "";
let productA = "";
let productB = "";

beforeAll(async () => {
  const stamp = randomUUID().slice(0, 8);
  ownerId = (
    await prisma.user.create({ data: { email: `loss-${stamp}@test.local`, name: "Dueña" } })
  ).id;
  productA = (
    await prisma.product.create({
      data: { orionCode: `ORN-LA-${stamp}`, code: `LA-${stamp}`, name: "Producto A", unit: "unidad" },
    })
  ).id;
  productB = (
    await prisma.product.create({
      data: { orionCode: `ORN-LB-${stamp}`, code: `LB-${stamp}`, name: "Producto B", unit: "unidad" },
    })
  ).id;
});

afterEach(async () => {
  const products = [productA, productB];
  await prisma.notificationOutbox.deleteMany({ where: { recipientId: ownerId } });
  await prisma.pendingInventoryReservation.deleteMany({ where: { batch: { productId: { in: products } } } });
  await prisma.inventoryAllocation.deleteMany({ where: { missingItem: { productId: { in: products } } } });
  await prisma.missingItem.deleteMany({ where: { productId: { in: products } } });
  await prisma.inventoryEntry.deleteMany({ where: { productId: { in: products } } });
  await prisma.productBatch.deleteMany({ where: { productId: { in: products } } });
  await prisma.pending.deleteMany({ where: { productId: { in: products } } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: { in: [productA, productB] } } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
});

async function receivedPending() {
  const { pending } = await registerPending({
    productId: productA,
    quantity: 5,
    promisedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    customerName: "Cliente",
    customerPhone: "3001234567",
    createdById: ownerId,
    idempotencyKey: randomUUID(),
  });
  await registerInventoryEntry({
    productId: productA,
    quantity: 5,
    batchCode: `L-${randomUUID().slice(0, 8)}`,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    createdById: ownerId,
    idempotencyKey: randomUUID(),
  });
  return prisma.pending.findUniqueOrThrow({ where: { id: pending.id } });
}

async function physicalUnitsOfA(): Promise<number> {
  const shelf = await prisma.productBatch.aggregate({
    where: { productId: productA },
    _sum: { quantity: true },
  });
  return shelf._sum.quantity ?? 0;
}

function changeToB(
  pending: Awaited<ReturnType<typeof receivedPending>>,
  actor: { actorId: string; canManageAll: boolean; canEditAll: boolean; canOrder: boolean; restricted: boolean },
) {
  return updatePending({
    id: pending.id,
    productId: productB,
    quantity: pending.quantity,
    promisedAt: pending.promisedAt,
    protectedFields: actor.restricted
      ? { state: "absent" }
      : { state: "valid", values: { customerName: "Cliente", customerPhone: "3001234567" } },
    manualSellerNameSent: false,
    expectedUpdatedAt: pending.updatedAt,
    actorId: actor.actorId,
    canManageAll: actor.canManageAll,
    canEditAll: actor.canEditAll,
    canOrder: actor.canOrder,
  });
}

describe("soltar una reserva conserva el stock físico", () => {
  it("tras la recepción hay 5 unidades físicas y 5 reservadas", async () => {
    const pending = await receivedPending();

    expect(pending.inventoryReadyQuantity).toBe(5);
    expect(await physicalUnitsOfA()).toBe(5);
    expect(
      (await prisma.pendingInventoryReservation.aggregate({
        where: { pendingId: pending.id },
        _sum: { quantity: true },
      }))._sum.quantity,
    ).toBe(5);
  });

  it("gerencia cambia el producto y conserva las 5 unidades físicas", async () => {
    const pending = await receivedPending();
    const result = await changeToB(pending, {
      actorId: "gerencia",
      canManageAll: true,
      canEditAll: true,
      canOrder: true,
      restricted: false,
    });

    expect(result.rejection).toBeNull();
    expect(await physicalUnitsOfA()).toBe(5);
  });

  it("OPERADOR no puede cambiar el producto con mercadería apartada", async () => {
    const pending = await receivedPending();
    const result = await changeToB(pending, {
      actorId: ownerId,
      canManageAll: can("OPERADOR", "canManageAllPendings"),
      canEditAll: can("OPERADOR", "canEditAllPendings"),
      canOrder: can("OPERADOR", "canOrderMissingItems"),
      restricted: false,
    });

    expect(result.rejection).toBe("PRODUCT_LOCKED_STOCK");
    expect((await prisma.pending.findUniqueOrThrow({ where: { id: pending.id } })).productId).toBe(productA);
    expect(await physicalUnitsOfA()).toBe(5);
  });

  it("cancelar el pendiente conserva las 5 unidades físicas", async () => {
    const pending = await receivedPending();
    const result = await cancelPendingCommitment({
      id: pending.id,
      cancelledById: ownerId,
      canManageAll: true,
    });

    expect(result.rejection).toBeNull();
    expect(await physicalUnitsOfA()).toBe(5);
    const cancelled = await prisma.pending.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(cancelled.inventoryReadyQuantity).toBe(0);
    expect(cancelled.reservedInventoryQuantity).toBe(0);
  });

  it("la corrección restringida no cambia el producto ni el stock", async () => {
    const pending = await receivedPending();
    const result = await changeToB(pending, {
      actorId: "bodega-ajena",
      canManageAll: false,
      canEditAll: true,
      canOrder: false,
      restricted: true,
    });

    expect(result.rejection).toBe("PRODUCT_LOCKED_SUPPLY");
    expect(await physicalUnitsOfA()).toBe(5);
  });
});

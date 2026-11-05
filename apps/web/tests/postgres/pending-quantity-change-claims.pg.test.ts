import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";
import { registerPending, updatePending } from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// Correcting only the quantity of a pending must resize its claim: lowering it
// frees reserved units for other customers, raising it reserves what is free
// and raises the rest as a missing item. Before #332 the reservations, the
// counters and the missing item stayed as they were (JD-A-008, JD-B-003).
// --------------------------------------------------------------------------

let ownerId = "";
let productId = "";

beforeAll(async () => {
  const stamp = randomUUID().slice(0, 8);
  ownerId = (await prisma.user.create({ data: { email: `qty-${stamp}@test.local`, name: "Gerencia" } })).id;
  productId = (await prisma.product.create({
    data: { orionCode: `QTY${stamp}`, code: `QTY-${stamp}`, name: "Producto", unit: "unidad" },
  })).id;
});

afterEach(async () => {
  await prisma.notificationOutbox.deleteMany({ where: { recipientId: ownerId } });
  await prisma.pendingInventoryReservation.deleteMany({ where: { batch: { productId } } });
  await prisma.inventoryAllocation.deleteMany({ where: { missingItem: { productId } } });
  await prisma.missingItem.deleteMany({ where: { productId } });
  await prisma.inventoryEntry.deleteMany({ where: { productId } });
  await prisma.productBatch.deleteMany({ where: { productId } });
  await prisma.pending.deleteMany({ where: { productId } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
});

async function shelf(quantity: number) {
  return prisma.productBatch.create({
    data: { productId, batchCode: `L-${randomUUID().slice(0, 6)}`, quantity, status: "DISPONIBLE" },
  });
}

async function register(quantity: number, customerName = "Cliente") {
  const { pending } = await registerPending({
    productId,
    quantity,
    promisedAt: new Date(Date.now() + 86_400_000),
    customerName,
    customerPhone: "3001234567",
    createdById: ownerId,
    idempotencyKey: randomUUID(),
  });
  return pending.id;
}

async function changeQuantity(id: string, quantity: number) {
  const current = await prisma.pending.findUniqueOrThrow({ where: { id } });
  return updatePending({
    id,
    productId,
    quantity,
    promisedAt: current.promisedAt,
    protectedFields: { state: "valid", values: { customerName: "Cliente", customerPhone: "3001234567" } },
    manualSellerNameSent: false,
    expectedUpdatedAt: current.updatedAt,
    actorId: "gerencia",
    canManageAll: true,
    canEditAll: true,
    canOrder: true,
  });
}

async function reserved(pendingId: string) {
  const sum = await prisma.pendingInventoryReservation.aggregate({ where: { pendingId }, _sum: { quantity: true } });
  return sum._sum.quantity ?? 0;
}

function openMissing(pendingId: string) {
  return prisma.missingItem.findMany({
    where: { originId: pendingId, status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] } },
  });
}

describe("corregir la cantidad de un pendiente", () => {
  it("bajarla libera las unidades reservadas de más", async () => {
    await shelf(10);
    const id = await register(10);

    const result = await changeQuantity(id, 4);

    expect(result.rejection).toBeNull();
    const after = await prisma.pending.findUniqueOrThrow({ where: { id } });
    expect(after.inventoryReadyQuantity).toBe(4);
    expect(after.reservedInventoryQuantity).toBe(4);
    expect(after.availabilityStatus).toBe("DISPONIBLE_COMPLETO");
    expect(await reserved(id)).toBe(4);
    expect(await openMissing(id)).toHaveLength(0);

    const other = await register(6, "Otro");
    expect(await reserved(other)).toBe(6);
  });

  it("subirla reserva lo libre y pide el resto como faltante", async () => {
    await shelf(6);
    const id = await register(4);

    await changeQuantity(id, 10);

    const after = await prisma.pending.findUniqueOrThrow({ where: { id } });
    expect(after.inventoryReadyQuantity).toBe(6);
    expect(after.reservedInventoryQuantity).toBe(6);
    expect(after.availabilityStatus).toBe("DISPONIBLE_PARCIAL");
    const open = await openMissing(id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ quantity: 4, receivedQuantity: 0 });
  });

  it("subirla conserva lo ya recibido del faltante abierto", async () => {
    const id = await register(5);
    await registerInventoryEntry({
      productId,
      quantity: 2,
      batchCode: `L-${randomUUID().slice(0, 6)}`,
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
      createdById: ownerId,
      idempotencyKey: randomUUID(),
    });

    await changeQuantity(id, 8);

    const after = await prisma.pending.findUniqueOrThrow({ where: { id } });
    expect(after.inventoryReadyQuantity).toBe(2);
    expect(await reserved(id)).toBe(2);
    const open = await openMissing(id);
    expect(open).toHaveLength(1);
    expect(open[0]!.receivedQuantity).toBe(2);
    expect(open[0]!.quantity - open[0]!.receivedQuantity).toBe(6);
  });
});

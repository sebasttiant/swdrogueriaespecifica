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

// --------------------------------------------------------------------------
// DEFECTO CONOCIDO (T7, sin corregir): unidades que desaparecen del inventario.
//
// La recepción que asigna mercadería a un faltante de cliente DESCUENTA esas
// unidades del lote (`reserveReceivedBatchQuantity`) y las deja en una reserva
// (`pending_inventory_reservations`). Después, todo camino que llama a
// `releasePendingReservations` BORRA la reserva y no devuelve nada al lote:
// esa función asume que una reserva nunca descontó el lote, y eso es cierto
// para lo que reserva el alta de un pendiente, pero no para lo que asigna la
// recepción. Las unidades quedan fuera del estante y fuera de toda reserva.
//
// Estos tests afirman el comportamiento CORRECTO (las unidades se conservan) y
// están marcados `it.fails`: hoy fallan, así que la suite queda verde con el
// defecto a la vista. El día que se corrija, `it.fails` pasa a fallar, y hay
// que quitarle la marca.
// --------------------------------------------------------------------------

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

// P de A sin stock y después una recepción de 5 que se le asigna entera.
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

// Recibido − (estante + reservado + entregado) del producto A: lo que falta.
async function missingUnitsOfA(): Promise<number> {
  const [received, shelf, reserved, delivered] = await Promise.all([
    prisma.inventoryEntry.aggregate({ where: { productId: productA }, _sum: { quantity: true } }),
    prisma.productBatch.aggregate({ where: { productId: productA }, _sum: { quantity: true } }),
    prisma.pendingInventoryReservation.aggregate({
      where: { batch: { productId: productA } },
      _sum: { quantity: true },
    }),
    prisma.pendingDelivery.aggregate({ where: { pending: { productId: productA } }, _sum: { quantity: true } }),
  ]);
  return (
    (received._sum.quantity ?? 0) -
    ((shelf._sum.quantity ?? 0) + (reserved._sum.quantity ?? 0) + (delivered._sum.quantity ?? 0))
  );
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

describe("DEFECTO CONOCIDO: soltar una reserva de recepción pierde las unidades", () => {
  it("punto de partida: tras la recepción no falta nada (5 reservadas, 0 en el estante)", async () => {
    const pending = await receivedPending();

    expect(pending.inventoryReadyQuantity).toBe(5);
    expect(await missingUnitsOfA()).toBe(0);
  });

  it.fails("DEFECTO CONOCIDO: gerencia cambia el producto y deberían conservarse las 5 unidades (hoy se pierden)", async () => {
    const pending = await receivedPending();

    const result = await changeToB(pending, {
      actorId: "gerencia",
      canManageAll: true,
      canEditAll: true,
      canOrder: true,
      restricted: false,
    });

    expect(result.rejection).toBeNull();
    expect(await missingUnitsOfA()).toBe(0);
  });

  // Contención T9: la corrección propia es ilimitada para quien tiene
  // `canEditAllPendings`, pero sin autoridad de compras no cambia el producto
  // de un pendiente con mercadería apartada. Así no llega a soltar la reserva.
  it("contención: OPERADOR no puede cambiar el producto de SU pendiente con mercadería apartada, y no se pierde nada", async () => {
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
    expect(await missingUnitsOfA()).toBe(0);
  });

  it.fails("DEFECTO CONOCIDO: cancelar el pendiente debería conservar las 5 unidades (hoy se pierden)", async () => {
    const pending = await receivedPending();

    const result = await cancelPendingCommitment({
      id: pending.id,
      cancelledById: ownerId,
      canManageAll: true,
    });

    expect(result.rejection).toBeNull();
    expect(await missingUnitsOfA()).toBe(0);
  });

  // La contención que YA existe: la corrección de una fila ajena no puede
  // cambiar el producto con stock asignado, así que no llega a soltar nada.
  it("la corrección restringida (fila ajena) no cambia el producto y no pierde nada", async () => {
    const pending = await receivedPending();

    const result = await changeToB(pending, {
      actorId: "bodega-ajena",
      canManageAll: false,
      canEditAll: true,
      canOrder: false,
      restricted: true,
    });

    expect(result.rejection).toBe("PRODUCT_LOCKED_SUPPLY");
    expect(await missingUnitsOfA()).toBe(0);
  });
});

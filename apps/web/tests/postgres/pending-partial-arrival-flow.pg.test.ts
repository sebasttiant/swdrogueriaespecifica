import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";
import {
  deliverPending,
  invoicePending,
  registerPending,
  resolveWaitlistDecision,
} from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// El escenario "llega solo una parte y el cliente decide" de
// `prisma/verify-fulfillment-invariants.ts` (db:verify), contra PostgreSQL
// real y por el flujo de negocio vigente: llega una parte, se FACTURA lo que
// llegó, se entrega, y el cliente decide sobre el resto.
//
// Fija por qué el guion fallaba en "se entregan las 3 unidades que llegaron":
// entregar exige factura previa (`validateDelivery` → NOT_INVOICED), y el
// guion entregaba sin facturar.
// --------------------------------------------------------------------------

let sellerId = "";
let productId = "";

beforeAll(async () => {
  const stamp = randomUUID().slice(0, 8);
  sellerId = (
    await prisma.user.create({ data: { email: `parcial-${stamp}@test.local`, name: "Vendedora" } })
  ).id;
  productId = (
    await prisma.product.create({
      data: { orionCode: `ORN-PA-${stamp}`, code: `PA-${stamp}`, name: "Producto parcial", unit: "unidad" },
    })
  ).id;
});

afterEach(async () => {
  await prisma.notificationOutbox.deleteMany({ where: { recipientId: sellerId } });
  await prisma.pendingDelivery.deleteMany({ where: { pending: { productId } } });
  await prisma.pendingInventoryReservation.deleteMany({ where: { batch: { productId } } });
  await prisma.inventoryAllocation.deleteMany({ where: { missingItem: { productId } } });
  await prisma.missingItem.deleteMany({ where: { productId } });
  await prisma.inventoryEntry.deleteMany({ where: { productId } });
  await prisma.productBatch.deleteMany({ where: { productId } });
  await prisma.pending.deleteMany({ where: { productId } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.user.deleteMany({ where: { id: sellerId } });
});

async function partiallyArrived() {
  const { pending } = await registerPending({
    productId,
    quantity: 5,
    promisedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    customerName: "Cliente F",
    customerPhone: "3001234567",
    createdById: sellerId,
    idempotencyKey: randomUUID(),
  });
  await registerInventoryEntry({
    productId,
    quantity: 3,
    batchCode: `LOTE-PARCIAL-${randomUUID().slice(0, 8)}`,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    createdById: sellerId,
    idempotencyKey: randomUUID(),
  });
  return pending.id;
}

async function invoiceAndDeliverThree(id: string) {
  expect(
    await invoicePending({ id, actorId: sellerId, scope: "own", quantity: 3, expectedInvoicedQuantity: 0 }),
  ).toEqual({ mode: "NORMAL" });
  const delivered = await deliverPending({ id, quantity: 3, deliveredById: sellerId, canManageAll: false });
  expect(delivered.rejection).toBeNull();
}

describe("db:verify · llega solo una parte y el cliente decide", () => {
  it("entregar sin facturar se rechaza con NOT_INVOICED (por eso fallaba el guion)", async () => {
    const id = await partiallyArrived();

    const result = await deliverPending({ id, quantity: 3, deliveredById: sellerId, canManageAll: false });

    expect(result.rejection).toBe("NOT_INVOICED");
  });

  // La respuesta del cliente se registra UNA sola vez (`ALREADY_DECIDED`): el
  // guion respondía "espera" y después "cerrar" sobre el mismo pendiente, y
  // eso hoy se rechaza. Cada respuesta va sobre su propio pendiente.
  it("responder dos veces sobre el mismo pendiente se rechaza con ALREADY_DECIDED", async () => {
    const id = await partiallyArrived();
    await invoiceAndDeliverThree(id);

    expect(await resolveWaitlistDecision({ id, decision: "espera", actorId: sellerId })).toBeNull();
    expect(await resolveWaitlistDecision({ id, decision: "cerrar", actorId: sellerId })).toBe(
      "ALREADY_DECIDED",
    );
  });

  it("flujo real, el cliente no espera: factura lo que llegó, entrega y cierra parcial", async () => {
    const id = await partiallyArrived();
    const arrived = await prisma.pending.findUniqueOrThrow({ where: { id } });
    expect(arrived.inventoryReadyQuantity).toBe(3);
    expect(arrived.availabilityStatus).toBe("DISPONIBLE_PARCIAL");

    await invoiceAndDeliverThree(id);
    expect((await prisma.pending.findUniqueOrThrow({ where: { id } })).status).toBe("PARCIAL");

    expect(await resolveWaitlistDecision({ id, decision: "cerrar", actorId: sellerId })).toBeNull();
    const closed = await prisma.pending.findUniqueOrThrow({ where: { id } });
    expect(closed.status).toBe("CLOSED_PARTIAL");
    expect(closed.deliveredQuantity).toBe(3);
    expect(closed.cancelledQuantity).toBe(2);
  });

  it("flujo real, el cliente espera: el pendiente sigue abierto con la nota", async () => {
    const id = await partiallyArrived();
    await invoiceAndDeliverThree(id);

    expect(await resolveWaitlistDecision({ id, decision: "espera", actorId: sellerId })).toBeNull();
    const waiting = await prisma.pending.findUniqueOrThrow({ where: { id } });
    expect(waiting.status).toBe("PARCIAL");
    expect(waiting.note ?? "").toContain("Cliente espera los 2");
  });
});

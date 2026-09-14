import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { invoiceableQuantity } from "@/features/pendientes/fulfillment-notice";
import { AUDIT_ACTIONS } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import type { PendingCustomerStatus } from "@/lib/generated/prisma/client";
import {
  countReadyToInvoicePendings,
  listPendings,
} from "@/server/repositories/pending.repository";
import { deliverPending, invoicePending } from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// U5 — facturación excepcional sin stock, contra PostgreSQL real.
//
// Lo que se prueba acá no lo puede probar un doble en memoria:
//
//   - el token de concurrencia bajo el lock de fila (un reintento factura UNA
//     vez);
//   - que la auditoría de la excepción viva en la MISMA transacción (si falla,
//     la factura se revierte);
//   - que la excepción no cree stock ni reservas, y que por eso la entrega
//     siga bloqueada;
//   - que la fila no aparezca como "Listos para facturar" (U4).
//
// Las filas respetan `pendings_quantities_check`: reserved ≤ inventoryReady ≤
// quantity, delivered ≤ invoiced ≤ quantity. La facturación NO está atada a
// inventoryReady desde `20260731010000_invoice_before_arrival`.
// --------------------------------------------------------------------------

const RUN = randomUUID().slice(0, 6);
const FUTURE = new Date("2099-01-01T15:00:00Z");

let productId = "";
let ownerId = "";
let otherOwnerId = "";
let batchId = "";

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `SINSTOCK-${Date.now()}`, name: `Suero ${RUN}`, unit: "unidad" },
  });
  productId = product.id;

  const owner = await prisma.user.create({
    data: { email: `sin-stock-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  ownerId = owner.id;

  const other = await prisma.user.create({
    data: { email: `sin-stock-otro-${randomUUID()}@test.local`, name: "Otro vendedor" },
  });
  otherOwnerId = other.id;

  const batch = await prisma.productBatch.create({
    data: {
      productId,
      batchCode: `L-${RUN}`,
      expiresAt: new Date("2027-06-01T00:00:00Z"),
      quantity: 100,
    },
  });
  batchId = batch.id;
});

afterEach(async () => {
  const pendings = await prisma.pending.findMany({ where: { productId }, select: { id: true } });
  const ids = pendings.map((row) => row.id);
  await prisma.auditLog.deleteMany({ where: { entity: "Pending", entityId: { in: ids } } });
  await prisma.pendingInventoryReservation.deleteMany({ where: { batchId } });
  await prisma.pendingDelivery.deleteMany({ where: { pending: { productId } } });
  await prisma.pending.deleteMany({ where: { productId } });
});

// El lote, el producto y los usuarios nacen una sola vez: el harness exige que
// el esquema quede vacío al terminar.
afterAll(async () => {
  await prisma.productBatch.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherOwnerId] } } });
});

type Seed = {
  quantity?: number;
  ready?: number;
  reserved?: number;
  invoiced?: number;
  customerStatus?: PendingCustomerStatus;
  owner?: string;
  /** Unidades reservadas en la TABLA de reservas, contra el lote de prueba. */
  reservations?: number;
};

async function seed(options: Seed = {}): Promise<string> {
  const pending = await prisma.pending.create({
    data: {
      productId,
      quantity: options.quantity ?? 10,
      inventoryReadyQuantity: options.ready ?? 0,
      reservedInventoryQuantity: options.reserved ?? 0,
      invoicedQuantity: options.invoiced ?? 0,
      deliveredQuantity: 0,
      status: "PENDIENTE",
      customerStatus: options.customerStatus ?? "POR_CONTACTAR",
      purchaseStatus: "SOLICITADO",
      promisedAt: FUTURE,
      createdById: options.owner ?? ownerId,
    },
  });
  if (options.reservations && options.reservations > 0) {
    await prisma.pendingInventoryReservation.create({
      data: { pendingId: pending.id, batchId, quantity: options.reservations },
    });
  }
  return pending.id;
}

function snapshot(id: string) {
  return prisma.pending.findUniqueOrThrow({
    where: { id },
    select: {
      quantity: true,
      inventoryReadyQuantity: true,
      reservedInventoryQuantity: true,
      invoicedQuantity: true,
      deliveredQuantity: true,
      customerStatus: true,
      invoicedAt: true,
      invoicedById: true,
    },
  });
}

function exceptionAudits(id: string) {
  return prisma.auditLog.findMany({
    where: { action: AUDIT_ACTIONS.PENDING_INVOICED_WITHOUT_STOCK, entityId: id },
  });
}

describe("token de concurrencia: un intento factura una sola vez", () => {
  it("una factura normal repetida con el mismo token es STALE la segunda vez", async () => {
    const id = await seed({ ready: 10 });
    const attempt = {
      id,
      actorId: ownerId,
      scope: "own" as const,
      quantity: 3,
      expectedInvoicedQuantity: 0,
    };

    await expect(invoicePending(attempt)).resolves.toEqual({ mode: "NORMAL" });
    await expect(invoicePending(attempt)).resolves.toBe("STALE");

    expect((await snapshot(id)).invoicedQuantity).toBe(3);
  });

  it("una factura sin stock repetida con el mismo token factura una sola vez", async () => {
    const id = await seed({ ready: 0 });
    const attempt = {
      id,
      actorId: ownerId,
      scope: "own" as const,
      quantity: 4,
      expectedInvoicedQuantity: 0,
      allowWithoutStock: true,
    };

    await expect(invoicePending(attempt)).resolves.toEqual({ mode: "WITHOUT_STOCK" });
    await expect(invoicePending(attempt)).resolves.toBe("STALE");

    expect((await snapshot(id)).invoicedQuantity).toBe(4);
    expect(await exceptionAudits(id)).toHaveLength(1);
  });

  it("un token viejo deja la fila idéntica y no audita la excepción", async () => {
    const id = await seed({ ready: 2, invoiced: 2, customerStatus: "FACTURADO" });
    const before = await snapshot(id);

    await expect(
      invoicePending({
        id,
        actorId: ownerId,
        scope: "own",
        quantity: 3,
        expectedInvoicedQuantity: 0,
        allowWithoutStock: true,
      }),
    ).resolves.toBe("STALE");

    expect(await snapshot(id)).toEqual(before);
    expect(await exceptionAudits(id)).toHaveLength(0);
  });
});

describe("auditoría atómica de la excepción", () => {
  it("una excepción exitosa deja exactamente un asiento con su payload", async () => {
    const id = await seed({ quantity: 10, ready: 3, invoiced: 1, customerStatus: "FACTURADO" });

    await expect(
      invoicePending({
        id,
        actorId: ownerId,
        scope: "own",
        quantity: 5,
        expectedInvoicedQuantity: 1,
        allowWithoutStock: true,
      }),
    ).resolves.toEqual({ mode: "WITHOUT_STOCK" });

    const audits = await exceptionAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      module: "pendientes",
      entity: "Pending",
      entityId: id,
      result: "SUCCESS",
      userId: ownerId,
      after: {
        invoicedQuantity: 5,
        stockAtInvoice: 2,
        totalInvoicedQuantity: 6,
        customerStatus: "FACTURADO",
      },
    });
  });

  it("si la auditoría falla, la factura se revierte entera", async () => {
    const id = await seed({ ready: 0 });
    const before = await snapshot(id);

    await expect(
      invoicePending(
        {
          id,
          actorId: ownerId,
          scope: "own",
          quantity: 4,
          expectedInvoicedQuantity: 0,
          allowWithoutStock: true,
        },
        new Date(),
        {
          writeAudit: async () => {
            throw new Error("audit unavailable");
          },
        },
      ),
    ).rejects.toThrow("audit unavailable");

    expect(await snapshot(id)).toEqual(before);
    expect(await exceptionAudits(id)).toHaveLength(0);
  });
});

describe("la excepción no crea stock ni habilita la entrega", () => {
  it("no toca inventario, reservas ni lotes", async () => {
    const id = await seed({ quantity: 10, ready: 2, reserved: 2, reservations: 2 });
    const before = await snapshot(id);
    const reservationsBefore = await prisma.pendingInventoryReservation.count({
      where: { pendingId: id },
    });
    const batchBefore = await prisma.productBatch.findUniqueOrThrow({ where: { id: batchId } });

    await expect(
      invoicePending({
        id,
        actorId: ownerId,
        scope: "own",
        quantity: 6,
        expectedInvoicedQuantity: 0,
        allowWithoutStock: true,
      }),
    ).resolves.toEqual({ mode: "WITHOUT_STOCK" });

    const after = await snapshot(id);
    expect(after.invoicedQuantity).toBe(6);
    expect(after.inventoryReadyQuantity).toBe(before.inventoryReadyQuantity);
    expect(after.reservedInventoryQuantity).toBe(before.reservedInventoryQuantity);
    expect(
      await prisma.pendingInventoryReservation.count({ where: { pendingId: id } }),
    ).toBe(reservationsBefore);
    expect(
      (await prisma.productBatch.findUniqueOrThrow({ where: { id: batchId } })).quantity,
    ).toBe(batchBefore.quantity);
  });

  it("la entrega sigue rechazada por falta de inventario", async () => {
    const id = await seed({ ready: 0 });
    await invoicePending({
      id,
      actorId: ownerId,
      scope: "own",
      quantity: 5,
      expectedInvoicedQuantity: 0,
      allowWithoutStock: true,
    });

    const result = await deliverPending({ id, quantity: 1, deliveredById: ownerId });

    expect(result.rejection).toBe("NO_INVENTORY");
    expect(await prisma.pendingDelivery.count({ where: { pendingId: id } })).toBe(0);
    expect((await snapshot(id)).deliveredQuantity).toBe(0);
  });
});

describe("la marca no cambia los otros caminos", () => {
  it("con stock suficiente es una factura normal, sin asiento de excepción", async () => {
    const id = await seed({ ready: 10 });

    await expect(
      invoicePending({
        id,
        actorId: ownerId,
        scope: "own",
        quantity: 4,
        expectedInvoicedQuantity: 0,
        allowWithoutStock: true,
      }),
    ).resolves.toEqual({ mode: "NORMAL" });

    expect((await snapshot(id)).invoicedQuantity).toBe(4);
    expect(await exceptionAudits(id)).toHaveLength(0);
  });

  it("el alcance propio sobre el pendiente de otro vendedor es NOT_OWNER, sin escribir", async () => {
    const id = await seed({ ready: 0, owner: otherOwnerId });
    const before = await snapshot(id);

    await expect(
      invoicePending({
        id,
        actorId: ownerId,
        scope: "own",
        quantity: 2,
        expectedInvoicedQuantity: 0,
        allowWithoutStock: true,
      }),
    ).resolves.toBe("NOT_OWNER");

    expect(await snapshot(id)).toEqual(before);
    expect(await exceptionAudits(id)).toHaveLength(0);
  });
});

describe("U4: una fila facturada sin stock no está lista para facturar", () => {
  it("no aparece en facturar=listos ni en el contador, y su X es 0", async () => {
    const id = await seed({ quantity: 10, ready: 0 });
    await expect(
      invoicePending({
        id,
        actorId: ownerId,
        scope: "own",
        quantity: 4,
        expectedInvoicedQuantity: 0,
        allowWithoutStock: true,
      }),
    ).resolves.toEqual({ mode: "WITHOUT_STOCK" });

    const listos = await listPendings({ ownerId, take: 100, axes: { invoice: "listos" } });
    expect(listos.items.some((item) => item.id === id)).toBe(false);
    expect(await countReadyToInvoicePendings(ownerId)).toBe(0);

    const all = await listPendings({ ownerId, take: 100 });
    const row = all.items.find((item) => item.id === id);
    expect(row).toBeDefined();
    expect(invoiceableQuantity(row!)).toBe(0);
  });
});

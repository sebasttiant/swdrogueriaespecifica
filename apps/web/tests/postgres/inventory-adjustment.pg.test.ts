import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import {
  AdjustmentIdempotencyConflictError,
  BatchNotFoundError,
  adjustBatchQuantity,
} from "@/server/services/inventory-adjustment.service";

// --------------------------------------------------------------------------
// Ajuste de inventario auditado.
//
// Hasta ahora la única forma de corregir una diferencia de conteo era un UPDATE
// a mano contra la base: sin motivo, sin responsable y sin rastro. Estas
// pruebas fijan lo contrario — que el ajuste deja constancia, y que hay dos
// cosas que NO puede hacer por más que se lo pidan.
//
// La primera es dejar el lote en negativo. La segunda, y la que de verdad
// importa, es sacar mercadería que ya está prometida a un cliente: ahí el
// problema no se ve en el inventario, se ve cuando la persona viene a buscar
// su pedido y no está.
// --------------------------------------------------------------------------

const run = `${Date.now()}${process.pid}`;
let productId = "";
let actorId = "";
const createdBatchIds: string[] = [];
const createdPendingIds: string[] = [];
const touchedProductIds: string[] = [];
const touchedActorIds: string[] = [];

async function seedBatch(quantity: number) {
  const batch = await prisma.productBatch.create({
    data: {
      productId,
      batchCode: `ADJ-${run}-${createdBatchIds.length}`,
      quantity,
      status: "DISPONIBLE",
    },
  });
  createdBatchIds.push(batch.id);
  return batch;
}

/** Promete unidades de un lote a un cliente, como lo hace un pendiente. */
async function reserve(batchId: string, quantity: number) {
  const pending = await prisma.pending.create({
    data: {
      productId,
      quantity,
      customerName: `Cliente ${run}`,
      customerPhone: "3000000000",
      promisedAt: new Date(Date.now() + 86_400_000),
      createdById: actorId,
      inventoryReadyQuantity: quantity,
      reservedInventoryQuantity: quantity,
      availabilityStatus: "DISPONIBLE_COMPLETO",
    },
  });
  createdPendingIds.push(pending.id);
  await prisma.pendingInventoryReservation.create({
    data: { pendingId: pending.id, batchId, quantity },
  });
  return pending.id;
}

/** La suite comparte una sola base: si esto no limpia, el harness ve basura. */
async function cleanupTouchedRows() {
  if (createdPendingIds.length > 0) {
    await prisma.pendingInventoryReservation.deleteMany({
      where: { pendingId: { in: createdPendingIds } },
    });
    await prisma.missingItem.deleteMany({
      where: { originId: { in: createdPendingIds } },
    });
    await prisma.auditLog.deleteMany({
      where: { entityId: { in: createdPendingIds } },
    });
    await prisma.pending.deleteMany({
      where: { id: { in: createdPendingIds } },
    });
    createdPendingIds.length = 0;
  }
  if (createdBatchIds.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { entityId: { in: createdBatchIds } },
    });
    await prisma.operationalCommand.deleteMany({
      where: { actorId: { in: touchedActorIds } },
    });
    await prisma.productBatch.deleteMany({
      where: { id: { in: createdBatchIds } },
    });
    createdBatchIds.length = 0;
  }
  if (touchedProductIds.length > 0) {
    await prisma.missingItem.deleteMany({
      where: { productId: { in: touchedProductIds } },
    });
    await prisma.product.deleteMany({
      where: { id: { in: touchedProductIds } },
    });
    touchedProductIds.length = 0;
  }
  if (touchedActorIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: touchedActorIds } } });
    touchedActorIds.length = 0;
  }
}

function input(
  overrides: Partial<Parameters<typeof adjustBatchQuantity>[0]> = {},
) {
  return {
    batchId: createdBatchIds[0]!,
    actorId,
    targetQuantity: 0,
    reason: "CONTEO_FISICO" as const,
    note: null,
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

beforeEach(async () => {
  await cleanupTouchedRows();
  const product = await prisma.product.create({
    data: {
      code: `ADJP-${run}-${randomUUID().slice(0, 8)}`,
      name: `Producto ajuste ${run}`,
      unit: "Caja",
      minStock: 0,
      reorderQty: 0,
    },
  });
  productId = product.id;
  touchedProductIds.push(product.id);
  const user = await prisma.user.create({
    data: { email: `ajuste-${randomUUID()}@test.local`, name: "Bodega" },
  });
  actorId = user.id;
  touchedActorIds.push(user.id);
});

afterEach(async () => {
  await cleanupTouchedRows();
});

afterAll(async () => {
  await cleanupTouchedRows();
  await prisma.$disconnect();
});

describe("adjustBatchQuantity", () => {
  it("descuenta las unidades y deja el motivo en la auditoría", async () => {
    const batch = await seedBatch(5);

    const result = await adjustBatchQuantity(
      input({
        batchId: batch.id,
        targetQuantity: 3,
        reason: "CAUSA_DESCONOCIDA",
      }),
    );

    expect(result.quantityAfter).toBe(3);
    const stored = await prisma.productBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect(stored.quantity).toBe(3);

    const audits = await prisma.auditLog.findMany({
      where: { entityId: batch.id, action: AUDIT_ACTIONS.INVENTORY_ADJUST },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      module: AUDIT_MODULES.ENTRADAS,
      entity: "ProductBatch",
      userId: actorId,
    });
    expect(audits[0]?.before).toMatchObject({ quantity: 5 });
    expect(audits[0]?.after).toMatchObject({
      quantity: 3,
      quantityDelta: -2,
      reason: "CAUSA_DESCONOCIDA",
    });
  });

  it("suma unidades cuando el conteo encuentra de más", async () => {
    const batch = await seedBatch(4);

    const result = await adjustBatchQuantity(
      input({ batchId: batch.id, targetQuantity: 7 }),
    );

    expect(result.quantityAfter).toBe(7);
  });

  it("guarda la nota cuando se escribe", async () => {
    const batch = await seedBatch(2);

    await adjustBatchQuantity(
      input({
        batchId: batch.id,
        targetQuantity: 1,
        note: "Conteo del lunes",
      }),
    );

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: batch.id, action: AUDIT_ACTIONS.INVENTORY_ADJUST },
    });
    expect(audit.after).toMatchObject({ note: "Conteo del lunes" });
  });

  it("NO deja el lote en negativo", async () => {
    const batch = await seedBatch(2);

    await expect(
      adjustBatchQuantity(input({ batchId: batch.id, targetQuantity: -1 })),
    ).rejects.toBeInstanceOf(RangeError);

    const stored = await prisma.productBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect(stored.quantity).toBe(2);
  });

  it("al bajar el estante reclama el falso Ya llegó del pendiente", async () => {
    const batch = await seedBatch(5);
    const pendingId = await reserve(batch.id, 5);

    const result = await adjustBatchQuantity(
      input({ batchId: batch.id, targetQuantity: 0 }),
    );

    expect(result.quantityAfter).toBe(0);
    expect(result.clampedPendingIds).toContain(pendingId);

    const pending = await prisma.pending.findUniqueOrThrow({
      where: { id: pendingId },
    });
    expect(pending.inventoryReadyQuantity).toBe(0);
    expect(pending.availabilityStatus).toBe("ESPERANDO");

    const missing = await prisma.missingItem.findFirst({
      where: { originId: pendingId, status: "FALTANTE" },
    });
    expect(missing?.quantity).toBe(5);
  });

  it("si el estante alcanza parcial, deja DISPONIBLE_PARCIAL", async () => {
    const batch = await seedBatch(5);
    const pendingId = await reserve(batch.id, 5);

    const result = await adjustBatchQuantity(
      input({ batchId: batch.id, targetQuantity: 2 }),
    );

    expect(result.quantityAfter).toBe(2);
    const pending = await prisma.pending.findUniqueOrThrow({
      where: { id: pendingId },
    });
    expect(pending.inventoryReadyQuantity).toBe(2);
    expect(pending.availabilityStatus).toBe("DISPONIBLE_PARCIAL");
  });

  it("un reintento del MISMO intento no ajusta dos veces", async () => {
    const batch = await seedBatch(5);
    const idempotencyKey = randomUUID();

    const first = await adjustBatchQuantity(
      input({ batchId: batch.id, targetQuantity: 3, idempotencyKey }),
    );
    const replay = await adjustBatchQuantity(
      input({ batchId: batch.id, targetQuantity: 3, idempotencyKey }),
    );

    expect(first.quantityAfter).toBe(3);
    expect(replay.quantityAfter).toBe(3);
    expect(replay.replayed).toBe(true);

    const stored = await prisma.productBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect(stored.quantity).toBe(3);
    const audits = await prisma.auditLog.findMany({
      where: { entityId: batch.id, action: AUDIT_ACTIONS.INVENTORY_ADJUST },
    });
    expect(audits).toHaveLength(1);
  });

  it("la misma clave con OTRO contenido es un error, no un reintento", async () => {
    const batch = await seedBatch(5);
    const idempotencyKey = randomUUID();
    await adjustBatchQuantity(
      input({ batchId: batch.id, targetQuantity: 3, idempotencyKey }),
    );

    await expect(
      adjustBatchQuantity(
        input({ batchId: batch.id, targetQuantity: 1, idempotencyKey }),
      ),
    ).rejects.toBeInstanceOf(AdjustmentIdempotencyConflictError);
  });

  it("rechaza un ajuste sin cambio: no hay nada que corregir", async () => {
    const batch = await seedBatch(5);

    await expect(
      adjustBatchQuantity(input({ batchId: batch.id, targetQuantity: 5 })),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("falla si el lote no existe", async () => {
    await expect(
      adjustBatchQuantity(input({ batchId: "no-existe", targetQuantity: 0 })),
    ).rejects.toBeInstanceOf(BatchNotFoundError);
  });

  it("no deja rastro de auditoría cuando el lote no existe", async () => {
    await expect(
      adjustBatchQuantity(input({ batchId: "no-existe", targetQuantity: 0 })),
    ).rejects.toBeInstanceOf(BatchNotFoundError);

    const audits = await prisma.auditLog.findMany({
      where: { entityId: "no-existe" },
    });
    expect(audits).toHaveLength(0);
  });
});

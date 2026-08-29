import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";
import { registerPending } from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// ¿Se entera un pendiente cargado DIRECTO por el vendedor de que llegó su
// mercancía?
//
// El handoff sostenía que no: que el pendiente solo se entera vía
// `MissingItem.originId`, y que por eso uno cargado directo se quedaba en
// ESPERANDO para siempre. Este archivo existe para comprobarlo contra la base
// real en vez de deducirlo leyendo, porque de esa respuesta dependía construir
// una rebanada entera.
//
// El camino que ejercita es el de producción, extremo a extremo:
//
//   vendedor carga el pendiente sin stock   → registerPending
//   bodega registra la entrada del producto → registerInventoryEntry
//   ¿el pendiente cambió de estado?
//
// Contra PostgreSQL real y no con dobles porque la asignación es una consulta
// cruda con FOR UPDATE sobre `missing_items`, con su propio orden de bloqueo:
// un doble diría que sí a cualquier cosa.
// --------------------------------------------------------------------------

let productId = "";

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { orionCode: `ORN-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, code: `DIR-${Date.now()}`, name: "Losartán 50mg", unit: "unidad" },
  });
  productId = product.id;
});

// El orden importa y no es cosmético: `PendingInventoryReservation` referencia
// al lote con `onDelete: Restrict`, así que borrar el lote antes que la reserva
// falla. Y el archivo tiene que dejar el esquema VACÍO, no solo consistente:
// `harness.pg.test.ts` afirma que pending/productBatch/missingItem quedan en 0,
// y `pending-review.pg.test.ts` cuenta filas. Un residuo acá rompe esos otros.
afterEach(async () => {
  await prisma.pendingInventoryReservation.deleteMany({ where: { batch: { productId } } });
  await prisma.inventoryAllocation.deleteMany({ where: { missingItem: { productId } } });
  await prisma.missingItem.deleteMany({ where: { productId } });
  await prisma.inventoryEntry.deleteMany({ where: { productId } });
  await prisma.productBatch.deleteMany({ where: { productId } });
  await prisma.pending.deleteMany({ where: { productId } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: productId } });
});

function newDirectPending(quantity: number) {
  return registerPending({
    productId,
    quantity,
    promisedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    customerName: "Cliente de mostrador",
    customerPhone: "3001234567",
    idempotencyKey: randomUUID(),
  });
}

// La entrada exige lote y vencimiento: `RegisterInventoryEntryInput` los tiene
// como obligatorios, no opcionales. Es el dato que Juan propuso no pedirle a
// bodega durante el piloto.
function registerEntry(quantity: number) {
  return registerInventoryEntry({
    productId,
    quantity,
    batchCode: `L-${randomUUID().slice(0, 8)}`,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    createdById: null,
    idempotencyKey: randomUUID(),
  });
}

describe("pendiente cargado directo · llegada de mercancía", () => {
  it("nace en ESPERANDO y con su propio faltante cuando no hay stock", async () => {
    const result = await newDirectPending(6);

    const pending = await prisma.pending.findUniqueOrThrow({
      where: { id: result.pending.id },
      select: { availabilityStatus: true, inventoryReadyQuantity: true },
    });

    expect(pending.availabilityStatus).toBe("ESPERANDO");
    expect(pending.inventoryReadyQuantity).toBe(0);
    // La pregunta de fondo: ¿queda algo que ligue este pendiente a una entrada
    // futura? Si esto es null, el pendiente es invisible para la asignación.
    expect(result.missingItem).not.toBeNull();
    expect(result.missingItem?.originId).toBe(result.pending.id);
  });

  it("pasa a DISPONIBLE_COMPLETO cuando bodega registra la entrada", async () => {
    const result = await newDirectPending(6);

    await registerEntry(6);

    const pending = await prisma.pending.findUniqueOrThrow({
      where: { id: result.pending.id },
      select: { availabilityStatus: true, inventoryReadyQuantity: true },
    });

    expect(pending.availabilityStatus).toBe("DISPONIBLE_COMPLETO");
    expect(pending.inventoryReadyQuantity).toBe(6);
  });

  it("queda en DISPONIBLE_PARCIAL cuando bodega registra solo una parte", async () => {
    const result = await newDirectPending(6);

    await registerEntry(2);

    const pending = await prisma.pending.findUniqueOrThrow({
      where: { id: result.pending.id },
      select: { availabilityStatus: true, inventoryReadyQuantity: true },
    });

    expect(pending.availabilityStatus).toBe("DISPONIBLE_PARCIAL");
    expect(pending.inventoryReadyQuantity).toBe(2);
  });
});

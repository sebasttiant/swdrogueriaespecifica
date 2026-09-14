import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";

// --------------------------------------------------------------------------
// La entrada de inventario NO recibe faltantes INFORMATIVOS.
//
// Un faltante informativo (`originId` nulo: alta manual de gerencia o reporte
// de vendedor) avisa que algo falta en el estante; no hay un cliente esperando
// esa mercadería. Hasta el cierre final la entrada repartía su cantidad FIFO
// sobre TODOS los faltantes abiertos del producto, informativos y ligados a
// venta mezclados, ordenados por antigüedad. Un informativo viejo absorbía
// unidades que tenían que ir al pendiente de un cliente, y ese pendiente se
// quedaba sin reserva y sin aviso. Esa es la regresión de este archivo.
//
// Ahora el reparto toma SOLO los ligados a una venta. El informativo no recibe
// asignación, no pasa a RECIBIDO por una entrada, y el stock que no va a un
// pendiente queda vendible.
//
// Antes este archivo probaba la recepción PARCIAL de un informativo pedido en
// cantidad (un defecto del CHECK `receivedQuantity <= quantity` que revertía la
// entrada entera). Ese camino ya no existe; lo que sigue vigente es la guarda de
// la base, que se conserva al final.
//
// POR QUÉ CONTRA POSTGRESQL REAL, y no con dobles. El reparto es SQL con
// `FOR UPDATE`: el filtro que decide qué faltantes participan vive en la
// consulta, y un doble devuelve las filas que el test le dé, filtre o no.
// --------------------------------------------------------------------------

let productId = "";
let sellerId = "";

beforeAll(async () => {
  const seller = await prisma.user.create({
    data: { email: `informativo-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  sellerId = seller.id;

  const product = await prisma.product.create({
    data: { orionCode: `ORN-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, code: `MAN-${Date.now()}`, name: "Amoxicilina 500mg", unit: "unidad" },
  });
  productId = product.id;
});

afterEach(async () => {
  await prisma.notificationOutbox.deleteMany({ where: { recipientId: sellerId } });
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

/**
 * Un faltante manual tal como lo crea el sistema: sin pendiente de cliente
 * (`originId` nulo) y con `quantity` en 1, que es el marcador que usa
 * `missing-item.service.ts`, no una cantidad que alguien haya contado.
 */
function createManualMissingItem(orderedQuantity: number, createdAt?: Date) {
  return prisma.missingItem.create({
    data: {
      productId,
      quantity: 1,
      orderedQuantity,
      receivedQuantity: 0,
      status: "PEDIDO",
      originId: null,
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

/** Un pendiente de cliente con su faltante ligado, como lo deja `registerPending`. */
async function createSaleLinkedMissingItem(quantity: number) {
  const pending = await prisma.pending.create({
    data: {
      productId,
      quantity,
      promisedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdById: sellerId,
      status: "PENDIENTE",
    },
  });
  const missing = await prisma.missingItem.create({
    data: { productId, quantity, status: "FALTANTE", originId: pending.id, createdById: sellerId },
  });
  return { pending, missing };
}

function registerEntry(quantity: number, options: { legacy?: boolean } = {}) {
  return registerInventoryEntry({
    productId,
    quantity,
    batchCode: `L-${randomUUID().slice(0, 8)}`,
    expiresAt: new Date("2027-12-31T00:00:00Z"),
    createdById: sellerId,
    // La clave de idempotencia es lo que activa el reparto FIFO cuantitativo;
    // sin ella el servicio toma el camino heredado (`closeMissingItemsByEntry`).
    ...(options.legacy ? {} : { idempotencyKey: randomUUID() }),
  });
}

async function onlyBatch() {
  const batches = await prisma.productBatch.findMany({ where: { productId } });
  expect(batches).toHaveLength(1);
  return batches[0]!;
}

describe("la entrada no recibe un faltante informativo", () => {
  it("un informativo pedido en cantidad queda intacto y el lote entero es vendible", async () => {
    const missing = await createManualMissingItem(50);

    const result = await registerEntry(2);

    expect(result.allocatedMissingCount).toBe(0);

    const after = await prisma.missingItem.findUniqueOrThrow({ where: { id: missing.id } });
    expect(after.receivedQuantity).toBe(0);
    expect(after.status).toBe("PEDIDO");
    expect(await prisma.inventoryAllocation.count({ where: { missingItemId: missing.id } })).toBe(0);

    // Sin reserva: el lote conserva todo lo que entró y nada lo compromete.
    const batch = await onlyBatch();
    expect(batch.quantity).toBe(2);
    expect(await prisma.pendingInventoryReservation.count({ where: { batchId: batch.id } })).toBe(0);
  });

  it("aunque entre todo lo pedido, NO pasa a RECIBIDO", async () => {
    const missing = await createManualMissingItem(3);

    await registerEntry(10);

    const after = await prisma.missingItem.findUniqueOrThrow({ where: { id: missing.id } });
    expect(after.receivedQuantity).toBe(0);
    expect(after.status).toBe("PEDIDO");
    expect((await onlyBatch()).quantity).toBe(10);
  });

  it("un informativo sin pedir tampoco recibe nada", async () => {
    const missing = await prisma.missingItem.create({
      data: {
        productId,
        quantity: 4,
        orderedQuantity: null,
        receivedQuantity: 0,
        status: "FALTANTE",
        originId: null,
      },
    });

    await registerEntry(9);

    const after = await prisma.missingItem.findUniqueOrThrow({ where: { id: missing.id } });
    expect(after.receivedQuantity).toBe(0);
    expect(after.status).toBe("FALTANTE");
  });

  it("el camino heredado (sin clave) tampoco lo cierra", async () => {
    const missing = await createManualMissingItem(3);

    const result = await registerEntry(3, { legacy: true });

    expect(result.closedMissingCount).toBe(0);
    const after = await prisma.missingItem.findUniqueOrThrow({ where: { id: missing.id } });
    expect(after.status).toBe("PEDIDO");
  });
});

// --------------------------------------------------------------------------
// LA REGRESIÓN QUE MOTIVÓ EL CAMBIO. Un informativo MÁS VIEJO y un ligado a
// venta MÁS NUEVO para el mismo producto. Por antigüedad el informativo iba
// primero y se quedaba con la entrada; el cliente, sin nada.
// --------------------------------------------------------------------------
describe("informativo viejo + pendiente de cliente nuevo", () => {
  const ayer = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

  it("la entrada va entera al pendiente y el informativo no recibe nada", async () => {
    const informativo = await createManualMissingItem(6, ayer());
    const { pending, missing: venta } = await createSaleLinkedMissingItem(6);

    const result = await registerEntry(6);

    expect(result.allocatedMissingCount).toBe(1);

    // El ligado a venta recibe todo y se cierra.
    const ventaAfter = await prisma.missingItem.findUniqueOrThrow({ where: { id: venta.id } });
    expect(ventaAfter.receivedQuantity).toBe(6);
    expect(ventaAfter.status).toBe("RECIBIDO");
    const allocations = await prisma.inventoryAllocation.findMany({
      where: { missingItem: { productId } },
    });
    expect(allocations).toEqual([
      expect.objectContaining({ missingItemId: venta.id, pendingId: pending.id, quantity: 6 }),
    ]);

    // Y el pendiente queda listo, reservado y avisado como siempre.
    const pendingAfter = await prisma.pending.findUniqueOrThrow({ where: { id: pending.id } });
    expect(pendingAfter.inventoryReadyQuantity).toBe(6);
    expect(pendingAfter.reservedInventoryQuantity).toBe(6);
    expect(pendingAfter.availabilityStatus).toBe("DISPONIBLE_COMPLETO");
    const batch = await onlyBatch();
    const reservation = await prisma.pendingInventoryReservation.findUniqueOrThrow({
      where: { pendingId_batchId: { pendingId: pending.id, batchId: batch.id } },
    });
    expect(reservation.quantity).toBe(6);
    // Reservar baja el saldo vendible del lote: todo quedó comprometido.
    expect(batch.quantity).toBe(0);

    // El informativo, intacto.
    const informativoAfter = await prisma.missingItem.findUniqueOrThrow({ where: { id: informativo.id } });
    expect(informativoAfter.receivedQuantity).toBe(0);
    expect(informativoAfter.status).toBe("PEDIDO");
  });

  it("el sobrante queda vendible en el lote, no va al informativo", async () => {
    const informativo = await createManualMissingItem(6, ayer());
    const { pending } = await createSaleLinkedMissingItem(6);

    await registerEntry(10);

    const pendingAfter = await prisma.pending.findUniqueOrThrow({ where: { id: pending.id } });
    expect(pendingAfter.inventoryReadyQuantity).toBe(6);
    expect((await onlyBatch()).quantity).toBe(4);

    const informativoAfter = await prisma.missingItem.findUniqueOrThrow({ where: { id: informativo.id } });
    expect(informativoAfter.receivedQuantity).toBe(0);
    expect(await prisma.inventoryAllocation.count({ where: { missingItemId: informativo.id } })).toBe(0);
  });
});

describe("la guarda de la base", () => {
  it("la base rechaza imputar por encima del techo, no solo el código", async () => {
    // La guarda de aplicación y la de la base son dos cosas distintas: si algún
    // día otra ruta escribe sin pasar por el servicio, esto tiene que seguir
    // fallando.
    const missing = await createManualMissingItem(6);

    await expect(
      prisma.missingItem.update({
        where: { id: missing.id },
        data: { receivedQuantity: 7 },
      }),
    ).rejects.toThrow();

    // Y hasta el techo, la base lo admite.
    const ok = await prisma.missingItem.update({
      where: { id: missing.id },
      data: { receivedQuantity: 6 },
    });
    expect(ok.receivedQuantity).toBe(6);
  });
});

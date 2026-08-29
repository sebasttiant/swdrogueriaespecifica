import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { deliverPending } from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// No se puede entregar mercadería que no existe.
//
// En producción apareció un pendiente con `deliveredQuantity = 5` e
// `inventoryReadyQuantity = 0`: se registró la salida comercial de cinco
// unidades que nunca entraron al inventario. El stock queda mintiendo, y la
// mentira solo se descubre cuando alguien va al estante y no encuentra nada.
//
// La causa: `validateDelivery` recibe estado, cantidades pedida, entregada y
// facturada — y NINGÚN dato de inventario. El único techo era el compromiso
// comercial. El segundo cerrojo tampoco cerraba: `consumePendingReservations`
// abría con `if (reservations.length === 0) return`, así que sin reservas no
// hacía nada y no fallaba.
//
// La fuente de verdad es la TABLA de reservas, no `reservedInventoryQuantity`:
// esa columna nunca se decrementa al entregar, así que es un acumulado y usarla
// como techo dejaría entregar dos veces lo mismo.
// --------------------------------------------------------------------------

let productId = "";
let vendedorId = "";
let batchId = "";
const RUN = randomUUID().slice(0, 6);

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `INV-${Date.now()}`, name: `Gel ${RUN}`, unit: "unidad" },
  });
  productId = product.id;
  const user = await prisma.user.create({
    data: { email: `v-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  vendedorId = user.id;
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
  await prisma.pendingInventoryReservation.deleteMany({ where: { batchId } });
  await prisma.pendingDelivery.deleteMany({ where: { pending: { productId } } });
  await prisma.pending.deleteMany({ where: { productId } });
});

// El lote y el producto nacen una sola vez, así que se borran una sola vez. El
// harness comprueba que el esquema quede vacío, y dejar filas acá haría fallar
// a otra prueba por algo que no tiene nada que ver con ella.
afterAll(async () => {
  await prisma.productBatch.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.user.deleteMany({ where: { id: vendedorId } });
});

type Estado = {
  quantity?: number;
  inventoryReadyQuantity?: number;
  reservedInventoryQuantity?: number;
  invoicedQuantity?: number;
  deliveredQuantity?: number;
  reservas?: number;
};

/** Un pendiente facturado y listo para el paso de entrega. */
async function nuevoPendiente(estado: Estado = {}): Promise<string> {
  const quantity = estado.quantity ?? 5;
  const pending = await prisma.pending.create({
    data: {
      productId,
      quantity,
      promisedAt: new Date("2026-09-01T15:00:00Z"),
      createdById: vendedorId,
      status: "PENDIENTE",
      purchaseStatus: "SOLICITADO",
      availabilityStatus: "ESPERANDO",
      // Facturado: la entrega exige factura previa, y no es lo que se prueba acá.
      customerStatus: "FACTURADO",
      invoicedQuantity: estado.invoicedQuantity ?? quantity,
      deliveredQuantity: estado.deliveredQuantity ?? 0,
      inventoryReadyQuantity: estado.inventoryReadyQuantity ?? 0,
      reservedInventoryQuantity: estado.reservedInventoryQuantity ?? 0,
    },
  });

  if (estado.reservas && estado.reservas > 0) {
    await prisma.pendingInventoryReservation.create({
      data: { pendingId: pending.id, batchId, quantity: estado.reservas },
    });
  }
  return pending.id;
}

async function leer(id: string) {
  return prisma.pending.findUniqueOrThrow({
    where: { id },
    select: { deliveredQuantity: true, status: true },
  });
}

describe("deliverPending · no se entrega lo que no hay", () => {
  // CASO A — el caso exacto de producción.
  it("rechaza la entrega con inventario en cero", async () => {
    const id = await nuevoPendiente({ inventoryReadyQuantity: 0, reservas: 0 });

    const result = await deliverPending({
      id, quantity: 5, deliveredById: vendedorId,
    });

    expect(result.rejection).not.toBeNull();
    expect(result.pending).toBeNull();
  });

  // CASO B — sin reservas no hay nada que consumir. Antes esto pasaba en
  // silencio: la función retornaba temprano y la entrega se registraba igual.
  it("rechaza una cantidad positiva cuando no hay reservas", async () => {
    const id = await nuevoPendiente({ inventoryReadyQuantity: 5, reservas: 0 });

    const result = await deliverPending({
      id, quantity: 3, deliveredById: vendedorId,
    });

    expect(result.rejection).not.toBeNull();
  });

  // CASO C
  it("rechaza entregar más de lo reservado", async () => {
    const id = await nuevoPendiente({ inventoryReadyQuantity: 2, reservas: 2 });

    const result = await deliverPending({
      id, quantity: 5, deliveredById: vendedorId,
    });

    expect(result.rejection).not.toBeNull();
  });

  // CASO D
  it("acepta exactamente lo reservado", async () => {
    const id = await nuevoPendiente({ inventoryReadyQuantity: 5, reservas: 5 });

    const result = await deliverPending({
      id, quantity: 5, deliveredById: vendedorId,
    });

    expect(result.rejection).toBeNull();
    expect((await leer(id)).deliveredQuantity).toBe(5);
  });

  // CASO E
  it("una entrega parcial consume solo su parte de la reserva", async () => {
    const id = await nuevoPendiente({ inventoryReadyQuantity: 5, reservas: 5 });

    await deliverPending({ id, quantity: 2, deliveredById: vendedorId });

    expect((await leer(id)).deliveredQuantity).toBe(2);
    const restante = await prisma.pendingInventoryReservation.aggregate({
      where: { pendingId: id }, _sum: { quantity: true },
    });
    expect(restante._sum.quantity).toBe(3);
  });

  // CASO F — la reserva ya consumida no se puede volver a gastar.
  it("no deja entregar de nuevo sobre una reserva agotada", async () => {
    const id = await nuevoPendiente({ inventoryReadyQuantity: 3, reservas: 3 });
    await deliverPending({ id, quantity: 3, deliveredById: vendedorId });

    const segunda = await deliverPending({
      id, quantity: 1, deliveredById: vendedorId,
    });

    expect(segunda.rejection).not.toBeNull();
    expect((await leer(id)).deliveredQuantity).toBe(3);
  });
});

// --------------------------------------------------------------------------
// Los pendientes históricos inconsistentes NO se tocan. Se les bloquea la
// entrega nueva y su reparación es un trabajo aparte, auditado: corregirlos
// acá en silencio sería reescribir la historia de una venta.
// --------------------------------------------------------------------------
describe("deliverPending · casos históricos inconsistentes", () => {
  // CASO J
  it("no modifica un pendiente que ya venía con entregas sin inventario", async () => {
    const id = await nuevoPendiente({
      quantity: 10, deliveredQuantity: 5, inventoryReadyQuantity: 0, reservas: 0,
    });
    const antes = await leer(id);

    const result = await deliverPending({
      id, quantity: 2, deliveredById: vendedorId,
    });

    expect(result.rejection).not.toBeNull();
    expect(await leer(id)).toEqual(antes);
  });

  // CASO I — el rechazo no puede dejar rastro de una entrega que no ocurrió.
  it("un rechazo no crea la fila de entrega", async () => {
    const id = await nuevoPendiente({ inventoryReadyQuantity: 0, reservas: 0 });

    await deliverPending({ id, quantity: 5, deliveredById: vendedorId });

    expect(
      await prisma.pendingDelivery.count({ where: { pendingId: id } }),
    ).toBe(0);
  });
});

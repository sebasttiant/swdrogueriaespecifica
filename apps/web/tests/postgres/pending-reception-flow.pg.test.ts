import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { markMissingItemArrived } from "@/server/repositories/missing-item.repository";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";
import {
  countPendingReception,
  listPendingReception,
} from "@/server/services/pending-reception.service";
import { enqueuePendingArrivalNotification } from "@/server/services/notification-outbox.service";
import { registerPending } from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// EL CICLO COMPLETO DE UN PEDIDO DE CLIENTE, contra PostgreSQL real.
//
//   vendedor registra el pendiente        → reserva lo que haya, déficit al resto
//   bodega ve el déficit                  → SIN que nadie apriete "Pedido"
//   bodega marca "Ya llegó"               → alerta 1, todavía NO se factura
//   bodega registra la entrada            → asigna, reserva, alerta 2
//   el vendedor factura y entrega
//
// LA REGLA QUE ESTE ARCHIVO PROTEGE: el pendiente NACE SOLICITADO. Cuando el
// vendedor lo registra, el cliente ya pidió el producto. Antes la recepción
// exigía estado PEDIDO —que lo pone gerencia pensando en el proveedor— y por
// eso el pedido de un cliente no le llegaba nunca a bodega.
//
// Va contra la base real porque todo lo que sostiene esto es SQL: el lock
// `FOR UPDATE` sobre los lotes, la asignación FIFO, el índice único del outbox
// que hace idempotentes las alertas.
// --------------------------------------------------------------------------

let productId = "";
let sellerId = "";

beforeAll(async () => {
  const seller = await prisma.user.create({
    data: { email: `recepcion-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  sellerId = seller.id;

  const product = await prisma.product.create({
    data: {
      orionCode: `ORN-RC-${Date.now()}`,
      code: `RC-${Date.now()}`,
      name: "Glucerna 400g",
      unit: "unidad",
    },
  });
  productId = product.id;
});

// El outbox va PRIMERO: sus filas apuntan al vendedor con onDelete Restrict, y
// la suite corre sin paralelismo sobre UNA base — el residuo de acá es la falla
// del archivo siguiente.
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

function nuevoPendiente(quantity: number, customerName = "Cliente") {
  return registerPending({
    productId,
    quantity,
    promisedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    customerName,
    customerPhone: "3001234567",
    createdById: sellerId,
    idempotencyKey: randomUUID(),
  });
}

function entrada(quantity: number) {
  return registerInventoryEntry({
    productId,
    quantity,
    batchCode: `L-${randomUUID().slice(0, 8)}`,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    createdById: sellerId,
    idempotencyKey: randomUUID(),
  });
}

function marcarLlegada(missingItemId: string, actorId = sellerId) {
  return prisma.$transaction(async (tx) => {
    const count = await markMissingItemArrived(tx, {
      id: missingItemId,
      arrivedById: actorId,
      arrivedAt: new Date(),
    });
    if (count === 0) return 0;
    const fila = await tx.missingItem.findUnique({
      where: { id: missingItemId },
      select: { originId: true },
    });
    if (fila?.originId) await enqueuePendingArrivalNotification(fila.originId, tx);
    return count;
  });
}

function avisos(eventType: string) {
  return prisma.notificationOutbox.count({
    where: { recipientId: sellerId, eventType },
  });
}

describe("creación con stock completo", () => {
  it("reserva todo, no descuenta el lote y no deja déficit", async () => {
    await entrada(20);
    const lotesAntes = await prisma.productBatch.aggregate({
      where: { productId },
      _sum: { quantity: true },
    });

    const { pending } = await nuevoPendiente(12);
    const fila = await prisma.pending.findUniqueOrThrow({ where: { id: pending.id } });

    expect(fila.inventoryReadyQuantity).toBe(12);
    expect(fila.availabilityStatus).toBe("DISPONIBLE_COMPLETO");
    // El lote NO se toca: el descuento físico es de la entrega. La reserva
    // impide la doble venta sin hacer mentir al inventario.
    const lotesDespues = await prisma.productBatch.aggregate({
      where: { productId },
      _sum: { quantity: true },
    });
    expect(lotesDespues._sum.quantity).toBe(lotesAntes._sum.quantity);
    // Y no queda nada para que bodega busque.
    expect(await countPendingReception()).toBe(0);
  });
});

describe("creación con stock parcial", () => {
  it("reserva lo que hay y le muestra a bodega SOLO lo que falta", async () => {
    await entrada(5);
    const { pending } = await nuevoPendiente(12);

    const fila = await prisma.pending.findUniqueOrThrow({ where: { id: pending.id } });
    expect(fila.inventoryReadyQuantity).toBe(5);
    expect(fila.availabilityStatus).toBe("DISPONIBLE_PARCIAL");

    const cola = await listPendingReception();
    const item = cola.find((c) => c.pendingId === pending.id);
    // Lo que falta CONSEGUIR, no lo que se pidió: mandar a buscar 12 cuando ya
    // hay 5 reservadas la manda a buscar de más.
    expect(item?.outstandingQuantity).toBe(7);
    expect(item?.reservedQuantity).toBe(5);
    expect(item?.requestedQuantity).toBe(12);
  });

  it("dos pendientes no reservan las mismas unidades", async () => {
    await entrada(5);

    await Promise.all([nuevoPendiente(4, "A"), nuevoPendiente(4, "B")]);

    const total = await prisma.pending.aggregate({
      where: { productId },
      _sum: { inventoryReadyQuantity: true },
    });
    expect(total._sum.inventoryReadyQuantity).toBe(5);
  });
});

describe("creación sin stock", () => {
  // EL TEST DE LA REGLA. Sin ninguna acción de gerencia, bodega tiene que ver
  // el pedido: el cliente ya lo pidió.
  it("bodega lo ve SIN que nadie lo marque como pedido", async () => {
    const { pending, missingItem } = await nuevoPendiente(10);

    // El riel nace en FALTANTE: nadie lo compró todavía.
    expect(missingItem?.status).toBe("FALTANTE");

    const cola = await listPendingReception();
    expect(cola.map((c) => c.pendingId)).toContain(pending.id);
    expect(await countPendingReception()).toBe(1);
  });

  it("bodega puede marcar la llegada desde FALTANTE", async () => {
    const { missingItem } = await nuevoPendiente(10);

    expect(await marcarLlegada(missingItem!.id)).toBe(1);

    const fila = await prisma.missingItem.findUniqueOrThrow({
      where: { id: missingItem!.id },
    });
    expect(fila.status).toBe("EN_BODEGA");
    // Auditoría: quién y cuándo.
    expect(fila.arrivedById).toBe(sellerId);
    expect(fila.arrivedAt).not.toBeNull();
  });

  it("marcar la llegada NO habilita facturar", async () => {
    const { pending, missingItem } = await nuevoPendiente(10);

    await marcarLlegada(missingItem!.id);

    const fila = await prisma.pending.findUniqueOrThrow({ where: { id: pending.id } });
    expect(fila.availabilityStatus).toBe("LLEGO_BODEGA");
    // Cero inventario asignado: la entrada todavía no se cargó.
    expect(fila.inventoryReadyQuantity).toBe(0);
  });
});

describe("las dos alertas", () => {
  it("la llegada emite el aviso de llegada y NINGUNO de disponibilidad", async () => {
    const { missingItem } = await nuevoPendiente(10);

    await marcarLlegada(missingItem!.id);

    expect(await avisos("pending.arrival.warehouse")).toBe(1);
    expect(await avisos("pending.availability.partial")).toBe(0);
    expect(await avisos("pending.availability.full")).toBe(0);
  });

  // IDEMPOTENCIA. La clave de transición es el estado alcanzado, así que
  // repetir la marca o recargar la página no encola un segundo aviso.
  it("repetir la llegada no duplica el aviso", async () => {
    const { missingItem } = await nuevoPendiente(10);

    await marcarLlegada(missingItem!.id);
    await marcarLlegada(missingItem!.id).catch(() => 0);
    await enqueuePendingArrivalNotification(
      (await prisma.missingItem.findUniqueOrThrow({ where: { id: missingItem!.id } }))
        .originId!,
    );

    expect(await avisos("pending.arrival.warehouse")).toBe(1);
  });

  it("la entrada completa emite el aviso de disponibilidad, una sola vez", async () => {
    const { missingItem } = await nuevoPendiente(10);
    await marcarLlegada(missingItem!.id);

    await entrada(10);

    expect(await avisos("pending.availability.full")).toBe(1);
    // Y el de llegada sigue siendo uno: son eventos distintos, no se pisan.
    expect(await avisos("pending.arrival.warehouse")).toBe(1);
  });

  it("una entrada parcial no emite el aviso de disponibilidad completa", async () => {
    const { pending } = await nuevoPendiente(10);

    await entrada(4);

    const fila = await prisma.pending.findUniqueOrThrow({ where: { id: pending.id } });
    expect(fila.inventoryReadyQuantity).toBe(4);
    expect(fila.availabilityStatus).toBe("DISPONIBLE_PARCIAL");
    expect(await avisos("pending.availability.full")).toBe(0);
    expect(await avisos("pending.availability.partial")).toBe(1);
  });

  it("el aviso llega a quien creó el pendiente", async () => {
    const { missingItem } = await nuevoPendiente(10);

    await marcarLlegada(missingItem!.id);

    const evento = await prisma.notificationOutbox.findFirstOrThrow({
      where: { eventType: "pending.arrival.warehouse" },
    });
    expect(evento.recipientId).toBe(sellerId);
  });
});

describe("entrada parcial y completa", () => {
  it("la parcial baja el déficit y mantiene el pendiente en la cola", async () => {
    const { pending } = await nuevoPendiente(10);
    expect((await listPendingReception())[0]?.outstandingQuantity).toBe(10);

    await entrada(4);

    const item = (await listPendingReception()).find((c) => c.pendingId === pending.id);
    expect(item?.outstandingQuantity).toBe(6);
    expect(item?.reservedQuantity).toBe(4);
  });

  it("la completa saca el pendiente de la cola de bodega", async () => {
    await nuevoPendiente(10);

    await entrada(10);

    expect(await countPendingReception()).toBe(0);
  });

  it("una entrada repetida con la misma clave no duplica inventario", async () => {
    await nuevoPendiente(10);
    const clave = randomUUID();
    const comun = {
      productId,
      quantity: 6,
      batchCode: "L-IDEM",
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      createdById: sellerId,
      idempotencyKey: clave,
    };

    await registerInventoryEntry(comun);
    await registerInventoryEntry(comun);

    // Se mide sobre las ENTRADAS y sobre lo reservado, no sobre el saldo del
    // lote: reservar unidades para un pendiente BAJA ese saldo a propósito
    // —dejan de estar disponibles para otro—, así que el lote puede quedar en
    // cero sin que nada se haya duplicado.
    const entradas = await prisma.inventoryEntry.count({ where: { productId } });
    expect(entradas).toBe(1);

    const reservado = await prisma.pending.aggregate({
      where: { productId },
      _sum: { inventoryReadyQuantity: true },
    });
    expect(reservado._sum.inventoryReadyQuantity).toBe(6);
  });
});

describe("privacidad de la cola de bodega", () => {
  it("no trae nombre, teléfono ni dirección del cliente", async () => {
    await nuevoPendiente(10, "Josefina Pérez");

    const serializado = JSON.stringify(await listPendingReception());

    expect(serializado).not.toContain("Josefina");
    expect(serializado).not.toContain("3001234567");
    expect(serializado).not.toContain("customerName");
  });
});

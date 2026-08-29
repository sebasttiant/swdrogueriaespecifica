import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { markMissingItemArrived } from "@/server/repositories/missing-item.repository";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";
import { enqueuePendingArrivalNotification } from "@/server/services/notification-outbox.service";
import {
  countPendingReception,
  listPendingReception,
} from "@/server/services/pending-reception.service";
import { registerPending } from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// DOS INDEPENDENCIAS QUE NO PUEDEN VOLVER A ROMPERSE.
//
// 1. EL DESTINATARIO DE LAS ALERTAS ES QUIEN CREÓ EL PENDIENTE, sea quien sea.
//    Gerencia también carga pendientes —está en el mostrador como cualquiera—
//    y si los avisos se dirigieran "al vendedor" por rol, un pendiente cargado
//    por ADMIN llegaría, se cargaría al inventario y nadie se enteraría.
//
// 2. `purchaseStatus` ES SEGUIMIENTO INTERNO DE GERENCIA Y NADA MÁS. Puede
//    informar en qué anda la compra, pero NUNCA volver a ser la puerta que deja
//    a bodega esperando una acción de gerencia. Ese fue el defecto original:
//    la recepción atada a un estado que ponía otro rol, y el pedido del cliente
//    que no le llegaba nunca a quien tenía que recibirlo.
//
// Contra PostgreSQL real: lo que se prueba es qué filas devuelven las consultas
// y a quién apuntan las del outbox, no cómo se ve la pantalla.
// --------------------------------------------------------------------------

const PURCHASE_STATUSES = [
  "POR_PEDIR",
  "SOLICITADO",
  "BUSQUEDA",
  "COTIZANDO",
  "AGOTADO",
] as const;

let productId = "";
const actores: Record<string, string> = {};

beforeAll(async () => {
  const product = await prisma.product.create({
    data: {
      orionCode: `ORN-IND-${Date.now()}`,
      code: `IND-${Date.now()}`,
      name: "Ensure Advance",
      unit: "unidad",
    },
  });
  productId = product.id;

  // Un usuario por rol que PUEDE crear pendientes. La capability la tienen los
  // cuatro; acá interesa que el aviso siga al creador real, no al rol.
  for (const rol of ["VENDEDOR", "OPERADOR", "ADMIN", "SUPERADMIN"]) {
    const user = await prisma.user.create({
      data: { email: `${rol.toLowerCase()}-${randomUUID()}@test.local`, name: rol },
    });
    actores[rol] = user.id;
  }
});

afterEach(async () => {
  await prisma.notificationOutbox.deleteMany({
    where: { recipientId: { in: Object.values(actores) } },
  });
  await prisma.pendingInventoryReservation.deleteMany({ where: { batch: { productId } } });
  await prisma.inventoryAllocation.deleteMany({ where: { missingItem: { productId } } });
  await prisma.missingItem.deleteMany({ where: { productId } });
  await prisma.inventoryEntry.deleteMany({ where: { productId } });
  await prisma.productBatch.deleteMany({ where: { productId } });
  await prisma.pending.deleteMany({ where: { productId } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(actores) } } });
});

function nuevoPendiente(quantity: number, creadorId: string) {
  return registerPending({
    productId,
    quantity,
    promisedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    customerName: "Cliente",
    customerPhone: "3001234567",
    createdById: creadorId,
    idempotencyKey: randomUUID(),
  });
}

function marcarLlegada(missingItemId: string, actorId: string) {
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

// --------------------------------------------------------------------------
describe("las alertas siguen al CREADOR, no al rol", () => {
  it.each(["VENDEDOR", "OPERADOR", "ADMIN", "SUPERADMIN"])(
    "un pendiente creado por %s recibe su alerta de llegada",
    async (rol) => {
      const creadorId = actores[rol]!;
      const { missingItem } = await nuevoPendiente(6, creadorId);

      await marcarLlegada(missingItem!.id, actores.SUPERADMIN!);

      const evento = await prisma.notificationOutbox.findFirstOrThrow({
        where: { eventType: "pending.arrival.warehouse" },
      });
      expect(evento.recipientId).toBe(creadorId);
    },
  );

  it.each(["VENDEDOR", "OPERADOR", "ADMIN", "SUPERADMIN"])(
    "un pendiente creado por %s recibe su alerta de disponibilidad",
    async (rol) => {
      const creadorId = actores[rol]!;
      await nuevoPendiente(6, creadorId);

      await registerInventoryEntry({
        productId,
        quantity: 6,
        batchCode: `L-${randomUUID().slice(0, 8)}`,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        createdById: actores.SUPERADMIN!,
        idempotencyKey: randomUUID(),
      });

      const evento = await prisma.notificationOutbox.findFirstOrThrow({
        where: { eventType: "pending.availability.full" },
      });
      expect(evento.recipientId).toBe(creadorId);
    },
  );

  // Quien RECIBE la mercadería no es el destinatario del aviso. El aviso es
  // para quien tiene al cliente esperando; bodega ya sabe que la descargó.
  it("el aviso NO va a quien marcó la llegada", async () => {
    const { missingItem } = await nuevoPendiente(6, actores.VENDEDOR!);

    await marcarLlegada(missingItem!.id, actores.ADMIN!);

    const evento = await prisma.notificationOutbox.findFirstOrThrow({
      where: { eventType: "pending.arrival.warehouse" },
    });
    expect(evento.recipientId).toBe(actores.VENDEDOR);
    expect(evento.recipientId).not.toBe(actores.ADMIN);
  });

  // Dos pendientes de dos creadores distintos: cada aviso a su dueño. Sin esto,
  // un `findFirst` mal escrito podría mandarle los dos al mismo.
  it("cada creador recibe SOLO el suyo", async () => {
    const a = await nuevoPendiente(3, actores.ADMIN!);
    const b = await nuevoPendiente(3, actores.OPERADOR!);

    await marcarLlegada(a.missingItem!.id, actores.SUPERADMIN!);
    await marcarLlegada(b.missingItem!.id, actores.SUPERADMIN!);

    const paraAdmin = await prisma.notificationOutbox.count({
      where: { recipientId: actores.ADMIN!, eventType: "pending.arrival.warehouse" },
    });
    const paraOperador = await prisma.notificationOutbox.count({
      where: { recipientId: actores.OPERADOR!, eventType: "pending.arrival.warehouse" },
    });
    expect(paraAdmin).toBe(1);
    expect(paraOperador).toBe(1);
  });
});

// --------------------------------------------------------------------------
describe("purchaseStatus informa, NUNCA bloquea", () => {
  async function conEstadoDeCompra(estado: (typeof PURCHASE_STATUSES)[number]) {
    const { pending, missingItem } = await nuevoPendiente(8, actores.VENDEDOR!);
    await prisma.pending.update({
      where: { id: pending.id },
      data: { purchaseStatus: estado },
    });
    return { pendingId: pending.id, missingItemId: missingItem!.id };
  }

  // EL TEST QUE CIERRA EL DEFECTO ORIGINAL. Cualquiera sea el estado de compra
  // —incluido POR_PEDIR, que es "gerencia todavía no hizo nada"— bodega ve el
  // pendiente. Nunca más esperando una acción de otro rol.
  it.each(PURCHASE_STATUSES)("con purchaseStatus=%s bodega lo sigue viendo", async (estado) => {
    const { pendingId } = await conEstadoDeCompra(estado);

    const cola = await listPendingReception();

    expect(cola.map((c) => c.pendingId)).toContain(pendingId);
    expect(await countPendingReception()).toBe(1);
  });

  it.each(PURCHASE_STATUSES)(
    "con purchaseStatus=%s se puede marcar la llegada",
    async (estado) => {
      const { missingItemId } = await conEstadoDeCompra(estado);

      expect(await marcarLlegada(missingItemId, actores.ADMIN!)).toBe(1);

      const fila = await prisma.missingItem.findUniqueOrThrow({
        where: { id: missingItemId },
      });
      expect(fila.status).toBe("EN_BODEGA");
    },
  );

  // AGOTADO es el más delicado: dice "no se consigue". Aun así, si aparece,
  // bodega tiene que poder recibirlo — el estado de compra es una opinión de
  // gerencia sobre el mercado, no un candado sobre el depósito.
  it("AGOTADO no impide recibir la mercadería si igual aparece", async () => {
    const { pendingId, missingItemId } = await conEstadoDeCompra("AGOTADO");

    // El actor da igual para lo que se prueba acá; lo que importa es que el
    // estado de compra no bloquee. Quién puede marcarla lo fija la capability,
    // y eso se prueba en `permissions.test.ts`.
    await marcarLlegada(missingItemId, actores.ADMIN!);

    const fila = await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } });
    expect(fila.availabilityStatus).toBe("LLEGO_BODEGA");
    // Y el estado de compra queda intacto: recibir no opina sobre la compra.
    expect(fila.purchaseStatus).toBe("AGOTADO");
  });

  // La entrada tampoco lo consulta: asigna contra el riel, no contra la opinión
  // de gerencia.
  it.each(PURCHASE_STATUSES)(
    "con purchaseStatus=%s la entrada reserva igual",
    async (estado) => {
      const { pendingId } = await conEstadoDeCompra(estado);

      await registerInventoryEntry({
        productId,
        quantity: 8,
        batchCode: `L-${randomUUID().slice(0, 8)}`,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        createdById: actores.ADMIN!,
        idempotencyKey: randomUUID(),
      });

      const fila = await prisma.pending.findUniqueOrThrow({ where: { id: pendingId } });
      expect(fila.inventoryReadyQuantity).toBe(8);
      expect(fila.availabilityStatus).toBe("DISPONIBLE_COMPLETO");
    },
  );

  // Y el riel NO necesita pasar por PEDIDO. Ese era el candado.
  it("bodega ve el pendiente con el riel todavía en FALTANTE", async () => {
    const { pendingId, missingItemId } = await conEstadoDeCompra("POR_PEDIR");

    const fila = await prisma.missingItem.findUniqueOrThrow({
      where: { id: missingItemId },
    });
    expect(fila.status).toBe("FALTANTE");

    const cola = await listPendingReception();
    expect(cola.map((c) => c.pendingId)).toContain(pendingId);
  });
});

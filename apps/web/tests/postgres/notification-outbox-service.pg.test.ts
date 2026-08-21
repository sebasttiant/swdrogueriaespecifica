import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { listInboxNotifications } from "@/server/notifications/notification-inbox";
import { enqueuePendingAvailabilityNotification } from "@/server/services/notification-outbox.service";

// El service es quien decide a quién avisar y cuál es la transición: deriva el
// dueño del pendiente (createdBy) y la clave del estado alcanzado, nunca del
// llamador. Se prueba contra PostgreSQL real porque la unicidad la garantiza el
// índice de la base: entre consultar y escribir se mete el reintento.

let productId = "";
let ownerId = "";
let otherOwnerId = "";

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `NOT-${Date.now()}`, name: "Amoxicilina", unit: "unidad" },
  });
  productId = product.id;

  const owner = await prisma.user.create({
    data: { email: `duenio-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  ownerId = owner.id;

  const otherOwner = await prisma.user.create({
    data: { email: `otro-${randomUUID()}@test.local`, name: "Otro vendedor" },
  });
  otherOwnerId = otherOwner.id;
});

afterEach(async () => {
  await prisma.notificationOutbox.deleteMany({
    where: { recipientId: { in: [ownerId, otherOwnerId] } },
  });
  await prisma.pending.deleteMany({ where: { productId } });
});

/** Un pendiente del dueño, listo para notificar su disponibilidad. */
async function newPendingFor(recipientId: string): Promise<string> {
  const pending = await prisma.pending.create({
    data: {
      productId,
      quantity: 1,
      promisedAt: new Date("2026-09-01T15:00:00Z"),
      createdById: recipientId,
      purchaseStatus: "SOLICITADO",
      availabilityStatus: "ESPERANDO",
      customerStatus: "POR_CONTACTAR",
    },
  });
  return pending.id;
}

describe("enqueuePendingAvailabilityNotification", () => {
  it("encola UNA notificación para el dueño cuando la disponibilidad pasa a parcial", async () => {
    const pendingId = await newPendingFor(ownerId);

    const outbox = await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
    });

    expect(outbox).not.toBeNull();
    expect(outbox?.recipientId).toBe(ownerId);
    expect(outbox?.eventType).toBe("pending.availability.partial");
    expect(outbox?.aggregateType).toBe("Pending");
    expect(outbox?.aggregateId).toBe(pendingId);
    expect(outbox?.status).toBe("PENDING");
  });

  it("usa el eventType completo cuando la disponibilidad pasa a completa", async () => {
    const pendingId = await newPendingFor(ownerId);

    const outbox = await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_COMPLETO",
    });

    expect(outbox?.eventType).toBe("pending.availability.full");
  });

  it("deriva el destinatario del pendiente", async () => {
    const pendingId = await newPendingFor(ownerId);

    const outbox = await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
    });

    expect(outbox?.recipientId).toBe(ownerId);
    // El otro vendedor no recibe nada: no hay parámetro para redirigirlo.
    const intruso = await listInboxNotifications(otherOwnerId);
    expect(intruso.items).toHaveLength(0);
  });

  it("reintentar la misma transición NO duplica, sin que el llamador haga nada", async () => {
    // REGRESIÓN. Cuando la clave de transición venía del llamador, un reintento
    // que generara un UUID nuevo no chocaba nunca contra el índice único: el
    // dedupe se veía correcto en las pruebas y en producción el dueño recibía
    // un aviso por intento. Acá se llama dos veces igual que el flujo real, sin
    // pasar ninguna clave.
    const pendingId = await newPendingFor(ownerId);

    const first = await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
    });
    const second = await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
    });

    expect(second?.id).toBe(first?.id);
    const rows = await prisma.notificationOutbox.count({ where: { aggregateId: pendingId } });
    expect(rows).toBe(1);
  });

  it("parcial y completa son transiciones DISTINTAS: avisa las dos veces", async () => {
    const pendingId = await newPendingFor(ownerId);

    const parcial = await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
    });
    const completa = await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_COMPLETO",
    });

    expect(completa?.id).not.toBe(parcial?.id);
    const rows = await prisma.notificationOutbox.count({ where: { aggregateId: pendingId } });
    expect(rows).toBe(2);
  });

  it("se encola en la MISMA transacción: si esta hace rollback, no queda nada", async () => {
    const pendingId = await newPendingFor(ownerId);

    await expect(
      prisma.$transaction(async (tx) => {
        await enqueuePendingAvailabilityNotification(
          { pendingId, availabilityStatus: "DISPONIBLE_PARCIAL" },
          tx,
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await prisma.notificationOutbox.count({ where: { aggregateId: pendingId } });
    expect(rows).toBe(0);
  });

  it("no encola nada si el pendiente no tiene dueño", async () => {
    const pending = await prisma.pending.create({
      data: {
        productId,
        quantity: 1,
        promisedAt: new Date("2026-09-01T15:00:00Z"),
        createdById: null,
        purchaseStatus: "SOLICITADO",
        availabilityStatus: "ESPERANDO",
        customerStatus: "POR_CONTACTAR",
      },
    });

    const outbox = await enqueuePendingAvailabilityNotification({
      pendingId: pending.id,
      availabilityStatus: "DISPONIBLE_PARCIAL",
    });

    expect(outbox).toBeNull();
  });
});

describe("bandeja in-app", () => {
  it("el aviso se ve apenas se encola, sin ningún paso de entrega", async () => {
    // REGRESIÓN. La pantalla filtraba por SENT y nadie corría el ciclo que lo
    // marcaba, así que el evento se quedaba en PENDING y el dueño no lo veía
    // nunca.
    const pendingId = await newPendingFor(ownerId);
    await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
    });

    const inbox = await listInboxNotifications(ownerId);

    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]!.eventType).toBe("pending.availability.partial");
    expect(inbox.items[0]!.payload).toEqual({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
    });
    expect(inbox.nextCursor).toBeNull();
  });

  it("cada persona ve solo lo suyo", async () => {
    const pendingId = await newPendingFor(ownerId);
    await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
    });

    const otra = await listInboxNotifications(otherOwnerId);
    expect(otra.items).toHaveLength(0);
  });

  it("pagina y ofrece cursor cuando hay más", async () => {
    const primero = await newPendingFor(ownerId);
    const segundo = await newPendingFor(ownerId);
    await enqueuePendingAvailabilityNotification({
      pendingId: primero,
      availabilityStatus: "DISPONIBLE_PARCIAL",
    });
    await enqueuePendingAvailabilityNotification({
      pendingId: segundo,
      availabilityStatus: "DISPONIBLE_PARCIAL",
    });

    const page = await listInboxNotifications(ownerId, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();

    const next = await listInboxNotifications(ownerId, { limit: 1, cursor: page.nextCursor! });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]!.id).not.toBe(page.items[0]!.id);
    expect(next.nextCursor).toBeNull();
  });
});

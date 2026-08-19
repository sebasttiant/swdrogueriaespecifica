import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { NotificationPayloadConflictError } from "@/server/repositories/notification-outbox.repository";
import {
  deliverInAppNotifications,
  listDeliveredNotifications,
} from "@/server/notifications/notification-transport";
import {
  enqueuePendingAvailabilityNotification,
} from "@/server/services/notification-outbox.service";

// El service es quien decide a quién avisar: deriva el dueño del pendiente
// (createdBy), nunca del llamador. El transport entrega at-least-once e in-app
// (D5): la presentación deduplica por la identidad del evento. Se prueba contra
// PostgreSQL real porque la unicidad la garantiza el índice de la base.

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
      transitionKey: randomUUID(),
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
      transitionKey: randomUUID(),
    });

    expect(outbox?.eventType).toBe("pending.availability.full");
  });

  it("deriva el destinatario del pendiente, nunca del llamador", async () => {
    const pendingId = await newPendingFor(ownerId);

    // El llamador podría pasar un recipientIdOverride arbitrario; el servicio lo ignora.
    const outbox = await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
      transitionKey: randomUUID(),
      recipientIdOverride: otherOwnerId,
    });

    expect(outbox?.recipientId).toBe(ownerId);
  });

  it("reintentar la misma transición NO duplica la notificación", async () => {
    const pendingId = await newPendingFor(ownerId);
    const transitionKey = randomUUID();

    const first = await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
      transitionKey,
    });
    const second = await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
      transitionKey,
    });

    expect(second?.id).toBe(first?.id);
    const rows = await prisma.notificationOutbox.count({
      where: { aggregateId: pendingId },
    });
    expect(rows).toBe(1);
  });

  it("misma transición con contenido distinto es un error del llamador", async () => {
    const pendingId = await newPendingFor(ownerId);
    const transitionKey = randomUUID();

    await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
      transitionKey,
    });

    await expect(
      enqueuePendingAvailabilityNotification({
        pendingId,
        availabilityStatus: "DISPONIBLE_COMPLETO",
        transitionKey,
      }),
    ).rejects.toBeInstanceOf(NotificationPayloadConflictError);
  });

  it("se encola en la MISMA transacción: si esta hace rollback, no queda nada", async () => {
    const pendingId = await newPendingFor(ownerId);

    await expect(
      prisma.$transaction(async (tx) => {
        await enqueuePendingAvailabilityNotification(
          {
            pendingId,
            availabilityStatus: "DISPONIBLE_PARCIAL",
            transitionKey: randomUUID(),
          },
          tx,
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await prisma.notificationOutbox.count({
      where: { aggregateId: pendingId },
    });
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
      transitionKey: randomUUID(),
    });

    expect(outbox).toBeNull();
  });
});

describe("transport in-app (entrega)", () => {
  it("entrega los eventos pendientes y los marca SENT", async () => {
    const pendingId = await newPendingFor(ownerId);
    await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
      transitionKey: randomUUID(),
    });

    const delivered = await deliverInAppNotifications();

    expect(delivered).toBe(1);
    const deliveredList = await listDeliveredNotifications(ownerId);
    expect(deliveredList).toHaveLength(1);
    expect(deliveredList[0]!.eventType).toBe("pending.availability.partial");
    expect(deliveredList[0]!.payload).toEqual({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
    });
  });

  it("la presentación solo ve las notificaciones del destinatario", async () => {
    const pendingId = await newPendingFor(ownerId);
    await enqueuePendingAvailabilityNotification({
      pendingId,
      availabilityStatus: "DISPONIBLE_PARCIAL",
      transitionKey: randomUUID(),
    });
    await deliverInAppNotifications();

    const otherList = await listDeliveredNotifications(otherOwnerId);
    expect(otherList).toHaveLength(0);
  });
});
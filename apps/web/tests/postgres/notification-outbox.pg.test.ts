import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  NotificationPayloadConflictError,
  enqueueOutboxEvent,
  fingerprintOf,
  findOutboxEvent,
  listPendingOutboxEvents,
  markOutboxEventFailed,
  markOutboxEventSent,
} from "@/server/repositories/notification-outbox.repository";

// El outbox de notificaciones es lo que garantiza que una transición de
// disponibilidad (parcial/completa) produce EXACTAMENTE una notificación para
// el dueño del pendiente, aunque el flujo se reintente. Se prueba contra
// PostgreSQL real porque la unicidad la garantiza el índice de la base: entre
// consultar y escribir se mete el reintento.

let recipientId = "";
let otherRecipientId = "";

const TRANSITION_KEY = () => randomUUID();
const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

function identity(transitionKey: string) {
  return {
    recipientId,
    eventType: "pending.availability.partial",
    aggregateType: "Pending",
    aggregateId: "pending-uno",
    transitionKey,
  };
}

beforeAll(async () => {
  const recipient = await prisma.user.create({
    data: { email: `duenio-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  recipientId = recipient.id;

  const other = await prisma.user.create({
    data: { email: `otro-${randomUUID()}@test.local`, name: "Otro vendedor" },
  });
  otherRecipientId = other.id;
});

afterEach(async () => {
  await prisma.notificationOutbox.deleteMany({
    where: { recipientId: { in: [recipientId, otherRecipientId] } },
  });
});

describe("enqueueOutboxEvent", () => {
  it("encola un evento PENDING con su identidad y payload", async () => {
    const transitionKey = TRANSITION_KEY();
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const outbox = await enqueueOutboxEvent({
      ...identity(transitionKey),
      fingerprint: fingerprintOf(payload),
      payload,
    });

    expect(outbox.recipientId).toBe(recipientId);
    expect(outbox.eventType).toBe("pending.availability.partial");
    expect(outbox.aggregateId).toBe("pending-uno");
    expect(outbox.transitionKey).toBe(transitionKey);
    expect(outbox.status).toBe("PENDING");
  });

  it("reintentar la misma transición NO duplica el evento", async () => {
    const transitionKey = TRANSITION_KEY();
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const fingerprint = fingerprintOf(payload);

    const first = await enqueueOutboxEvent({ ...identity(transitionKey), fingerprint, payload });
    const second = await enqueueOutboxEvent({ ...identity(transitionKey), fingerprint, payload });

    expect(second.id).toBe(first.id);
    const rows = await prisma.notificationOutbox.count({ where: { aggregateId: "pending-uno" } });
    expect(rows).toBe(1);
  });

  it("misma transición con contenido distinto es un error del llamador", async () => {
    const transitionKey = TRANSITION_KEY();
    const payloadA = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const payloadB = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_COMPLETO" };

    await enqueueOutboxEvent({
      ...identity(transitionKey),
      fingerprint: fingerprintOf(payloadA),
      payload: payloadA,
    });

    await expect(
      enqueueOutboxEvent({
        ...identity(transitionKey),
        fingerprint: fingerprintOf(payloadB),
        payload: payloadB,
      }),
    ).rejects.toBeInstanceOf(NotificationPayloadConflictError);
  });

  it("se encola en la MISMA transacción: si esta hace rollback, no queda nada", async () => {
    const transitionKey = TRANSITION_KEY();
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };

    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueOutboxEvent(
          { ...identity(transitionKey), fingerprint: fingerprintOf(payload), payload },
          tx,
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await prisma.notificationOutbox.count({ where: { aggregateId: "pending-uno" } });
    expect(rows).toBe(0);
  });

  it("no confunde transiciones distintas del mismo agregado", async () => {
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const fingerprint = fingerprintOf(payload);

    const first = await enqueueOutboxEvent({
      ...identity(TRANSITION_KEY()),
      fingerprint,
      payload,
    });
    const second = await enqueueOutboxEvent({
      ...identity(TRANSITION_KEY()),
      fingerprint,
      payload,
    });

    expect(second.id).not.toBe(first.id);
  });
});

describe("lectura y estados", () => {
  it("findOutboxEvent devuelve el evento por identidad", async () => {
    const transitionKey = TRANSITION_KEY();
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    await enqueueOutboxEvent({
      ...identity(transitionKey),
      fingerprint: fingerprintOf(payload),
      payload,
    });

    const found = await findOutboxEvent(identity(transitionKey));
    expect(found?.aggregateId).toBe("pending-uno");
  });

  it("listPendingOutboxEvents devuelve solo los PENDING por antigüedad", async () => {
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const fingerprint = fingerprintOf(payload);
    const older = await enqueueOutboxEvent({
      ...identity(TRANSITION_KEY()),
      fingerprint,
      payload,
    });
    const newer = await enqueueOutboxEvent({
      ...identity(TRANSITION_KEY()),
      fingerprint,
      payload,
    });

    const pending = await listPendingOutboxEvents(10);
    const ids = pending.map((e) => e.id);
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
  });

  it("markOutboxEventSent marca SENT con sentAt", async () => {
    const transitionKey = TRANSITION_KEY();
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const event = await enqueueOutboxEvent({
      ...identity(transitionKey),
      fingerprint: fingerprintOf(payload),
      payload,
    });

    const sent = await markOutboxEventSent(event.id);
    expect(sent.status).toBe("SENT");
    expect(sent.sentAt).not.toBeNull();

    const pending = await listPendingOutboxEvents(10);
    expect(pending.map((e) => e.id)).not.toContain(event.id);
  });

  it("markOutboxEventFailed marca FAILED e incrementa intentos", async () => {
    const transitionKey = TRANSITION_KEY();
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const event = await enqueueOutboxEvent({
      ...identity(transitionKey),
      fingerprint: fingerprintOf(payload),
      payload,
    });

    const failed = await markOutboxEventFailed(event.id, "transport error");
    expect(failed.status).toBe("FAILED");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe("transport error");
  });
});

describe("fingerprintOf", () => {
  it("es estable ante el orden de claves del payload", () => {
    const a = fingerprintOf({ pendingId: "x", availabilityStatus: "DISPONIBLE_PARCIAL" });
    const b = fingerprintOf({ availabilityStatus: "DISPONIBLE_PARCIAL", pendingId: "x" });
    expect(a).toBe(b);
  });

  it("cambia cuando cambia el contenido", () => {
    const a = fingerprintOf({ pendingId: "x", availabilityStatus: "DISPONIBLE_PARCIAL" });
    const b = fingerprintOf({ pendingId: "x", availabilityStatus: "DISPONIBLE_COMPLETO" });
    expect(a).not.toBe(b);
  });
});
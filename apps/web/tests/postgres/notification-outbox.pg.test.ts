import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  MAX_DELIVERY_ATTEMPTS,
  MAX_NOTIFICATION_PAGE_SIZE,
  NotificationEnqueueRaceError,
  NotificationPayloadConflictError,
  enqueueOutboxEvent,
  fingerprintOf,
  findOutboxEvent,
  listPendingOutboxEvents,
  listRecipientNotifications,
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

const EVENT_TYPE = "pending.availability.partial";
const TRANSITION_KEY = () => randomUUID();

function identity(transitionKey: string, aggregateId = "pending-uno") {
  return {
    recipientId,
    eventType: EVENT_TYPE,
    aggregateType: "Pending",
    aggregateId,
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
      fingerprint: fingerprintOf(EVENT_TYPE, payload),
      payload,
    });

    expect(outbox.recipientId).toBe(recipientId);
    expect(outbox.eventType).toBe(EVENT_TYPE);
    expect(outbox.aggregateId).toBe("pending-uno");
    expect(outbox.transitionKey).toBe(transitionKey);
    expect(outbox.status).toBe("PENDING");
  });

  it("reintentar la misma transición NO duplica el evento", async () => {
    const transitionKey = TRANSITION_KEY();
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const fingerprint = fingerprintOf(EVENT_TYPE, payload);

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
      fingerprint: fingerprintOf(EVENT_TYPE, payloadA),
      payload: payloadA,
    });

    await expect(
      enqueueOutboxEvent({
        ...identity(transitionKey),
        fingerprint: fingerprintOf(EVENT_TYPE, payloadB),
        payload: payloadB,
      }),
    ).rejects.toBeInstanceOf(NotificationPayloadConflictError);
  });

  it("misma transición y mismo payload con OTRO eventType también es conflicto", async () => {
    // Sin `eventType` dentro de la huella, este caso devolvía en silencio el
    // evento del primer llamador, con un tipo distinto al que se pidió.
    const transitionKey = TRANSITION_KEY();
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };

    await enqueueOutboxEvent({
      ...identity(transitionKey),
      fingerprint: fingerprintOf(EVENT_TYPE, payload),
      payload,
    });

    await expect(
      enqueueOutboxEvent({
        ...identity(transitionKey),
        eventType: "pending.availability.full",
        fingerprint: fingerprintOf("pending.availability.full", payload),
        payload,
      }),
    ).rejects.toBeInstanceOf(NotificationPayloadConflictError);
  });

  it("se encola en la MISMA transacción: si esta hace rollback, no queda nada", async () => {
    const transitionKey = TRANSITION_KEY();
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };

    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueOutboxEvent(
          { ...identity(transitionKey), fingerprint: fingerprintOf(EVENT_TYPE, payload), payload },
          tx,
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await prisma.notificationOutbox.count({ where: { aggregateId: "pending-uno" } });
    expect(rows).toBe(0);
  });

  it("perder la carrera DENTRO de una transacción avisa que hay que reintentar", async () => {
    // REGRESIÓN. La versión anterior resolvía la colisión consultando de nuevo
    // dentro del `catch`. PostgreSQL aborta la transacción entera al violar la
    // unicidad, así que esa consulta moría con `25P02` y enmascaraba el error
    // real — justo en el único contexto donde el outbox se usa.
    const transitionKey = TRANSITION_KEY();
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const fingerprint = fingerprintOf(EVENT_TYPE, payload);

    // REPEATABLE READ congela la instantánea en la primera sentencia, así que
    // la lectura interna de `enqueueOutboxEvent` NO ve al ganador y el choque
    // llega al INSERT. Es la misma interposición que ocurre en READ COMMITTED
    // cuando el otro commitea justo entre esa lectura y esa escritura; acá pasa
    // siempre en vez de a veces.
    const attempt = prisma.$transaction(
      async (tx) => {
        expect(await findOutboxEvent(identity(transitionKey), tx)).toBeNull();

        // Otra conexión encola y COMMITEA esa misma transición en el medio.
        await prisma.notificationOutbox.create({
          data: { ...identity(transitionKey), fingerprint, payload },
        });

        return enqueueOutboxEvent({ ...identity(transitionKey), fingerprint, payload }, tx);
      },
      { isolationLevel: "RepeatableRead" },
    );

    await expect(attempt).rejects.toBeInstanceOf(NotificationEnqueueRaceError);
    // El ganador de la carrera quedó, y quedó UNO solo.
    const rows = await prisma.notificationOutbox.count({ where: { aggregateId: "pending-uno" } });
    expect(rows).toBe(1);
  });

  it("no confunde transiciones distintas del mismo agregado", async () => {
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const fingerprint = fingerprintOf(EVENT_TYPE, payload);

    const first = await enqueueOutboxEvent({ ...identity(TRANSITION_KEY()), fingerprint, payload });
    const second = await enqueueOutboxEvent({ ...identity(TRANSITION_KEY()), fingerprint, payload });

    expect(second.id).not.toBe(first.id);
  });
});

describe("lectura y estados", () => {
  it("findOutboxEvent devuelve el evento por identidad", async () => {
    const transitionKey = TRANSITION_KEY();
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    await enqueueOutboxEvent({
      ...identity(transitionKey),
      fingerprint: fingerprintOf(EVENT_TYPE, payload),
      payload,
    });

    const found = await findOutboxEvent(identity(transitionKey));
    expect(found?.aggregateId).toBe("pending-uno");
  });

  it("listPendingOutboxEvents devuelve solo los PENDING por antigüedad", async () => {
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const fingerprint = fingerprintOf(EVENT_TYPE, payload);
    const older = await enqueueOutboxEvent({ ...identity(TRANSITION_KEY()), fingerprint, payload });
    const newer = await enqueueOutboxEvent({ ...identity(TRANSITION_KEY()), fingerprint, payload });

    const ids = await prisma.$transaction(async (tx) =>
      (await listPendingOutboxEvents(10, tx)).map((e) => e.id),
    );
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
  });

  it("dos drenadores concurrentes NO se llevan el mismo evento", async () => {
    // `FOR UPDATE SKIP LOCKED`: sin él, los dos leen el mismo lote y el mismo
    // aviso sale dos veces por el transporte externo.
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const fingerprint = fingerprintOf(EVENT_TYPE, payload);
    await enqueueOutboxEvent({ ...identity(TRANSITION_KEY()), fingerprint, payload });

    let secondBatch: string[] = [];
    const firstBatch = await prisma.$transaction(async (tx) => {
      const mine = await listPendingOutboxEvents(10, tx);
      // Mientras la primera sostiene el lock, la segunda mira y se va vacía.
      secondBatch = await prisma.$transaction(async (other) =>
        (await listPendingOutboxEvents(10, other)).map((e) => e.id),
      );
      return mine.map((e) => e.id);
    });

    expect(firstBatch).toHaveLength(1);
    expect(secondBatch).toHaveLength(0);
  });

  it("markOutboxEventSent marca SENT con sentAt y lo saca de la cola", async () => {
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const event = await enqueueOutboxEvent({
      ...identity(TRANSITION_KEY()),
      fingerprint: fingerprintOf(EVENT_TYPE, payload),
      payload,
    });

    const sent = await markOutboxEventSent(event.id);
    expect(sent.status).toBe("SENT");
    expect(sent.sentAt).not.toBeNull();

    const pending = await prisma.$transaction((tx) => listPendingOutboxEvents(10, tx));
    expect(pending.map((e) => e.id)).not.toContain(event.id);
  });

  it("un intento fallido devuelve el evento a la cola en vez de perderlo", async () => {
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const event = await enqueueOutboxEvent({
      ...identity(TRANSITION_KEY()),
      fingerprint: fingerprintOf(EVENT_TYPE, payload),
      payload,
    });

    const failed = await markOutboxEventFailed(event.id, "transport error");
    expect(failed.status).toBe("PENDING");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe("transport error");

    const pending = await prisma.$transaction((tx) => listPendingOutboxEvents(10, tx));
    expect(pending.map((e) => e.id)).toContain(event.id);
  });

  it("al agotar los intentos queda FAILED y deja de tomarse", async () => {
    const payload = { pendingId: "pending-uno", availabilityStatus: "DISPONIBLE_PARCIAL" };
    const event = await enqueueOutboxEvent({
      ...identity(TRANSITION_KEY()),
      fingerprint: fingerprintOf(EVENT_TYPE, payload),
      payload,
    });

    let last = event;
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i += 1) {
      last = await markOutboxEventFailed(event.id, `intento ${i + 1}`);
    }

    expect(last.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(last.status).toBe("FAILED");

    const pending = await prisma.$transaction((tx) => listPendingOutboxEvents(10, tx));
    expect(pending.map((e) => e.id)).not.toContain(event.id);
  });
});

describe("listRecipientNotifications", () => {
  async function enqueueFor(id: string, aggregateId: string) {
    const payload = { pendingId: aggregateId, availabilityStatus: "DISPONIBLE_PARCIAL" };
    return prisma.notificationOutbox.create({
      data: {
        recipientId: id,
        eventType: EVENT_TYPE,
        aggregateType: "Pending",
        aggregateId,
        transitionKey: TRANSITION_KEY(),
        fingerprint: fingerprintOf(EVENT_TYPE, payload),
        payload,
      },
    });
  }

  it("devuelve lo del destinatario, de lo más nuevo a lo más viejo", async () => {
    const older = await enqueueFor(recipientId, "pending-uno");
    const newer = await enqueueFor(recipientId, "pending-dos");
    await enqueueFor(otherRecipientId, "pending-tres");

    const rows = await listRecipientNotifications(recipientId);
    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it("muestra también lo que el transporte externo no pudo entregar", async () => {
    // El estado describe al transporte, no a la persona: filtrar por SENT haría
    // que un fallo del proveedor —o su ausencia— le borre el aviso al dueño.
    const event = await enqueueFor(recipientId, "pending-uno");
    await prisma.notificationOutbox.update({
      where: { id: event.id },
      data: { status: "FAILED", attempts: MAX_DELIVERY_ATTEMPTS, lastError: "sin proveedor" },
    });

    const rows = await listRecipientNotifications(recipientId);
    expect(rows.map((r) => r.id)).toEqual([event.id]);
  });

  it("acota la página y avanza por cursor", async () => {
    const first = await enqueueFor(recipientId, "pending-uno");
    const second = await enqueueFor(recipientId, "pending-dos");
    const third = await enqueueFor(recipientId, "pending-tres");

    const page = await listRecipientNotifications(recipientId, { limit: 2 });
    expect(page.map((r) => r.id)).toEqual([third.id, second.id]);

    const next = await listRecipientNotifications(recipientId, { limit: 2, cursor: second.id });
    expect(next.map((r) => r.id)).toEqual([first.id]);
  });

  it("rechaza un techo fuera de rango en vez de traer la tabla entera", async () => {
    await expect(
      listRecipientNotifications(recipientId, { limit: MAX_NOTIFICATION_PAGE_SIZE + 2 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      listRecipientNotifications(recipientId, { limit: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe("fingerprintOf", () => {
  it("es estable ante el orden de claves del payload", () => {
    const a = fingerprintOf(EVENT_TYPE, {
      pendingId: "x",
      availabilityStatus: "DISPONIBLE_PARCIAL",
    });
    const b = fingerprintOf(EVENT_TYPE, {
      availabilityStatus: "DISPONIBLE_PARCIAL",
      pendingId: "x",
    });
    expect(a).toBe(b);
  });

  it("cambia cuando cambia el contenido", () => {
    const a = fingerprintOf(EVENT_TYPE, {
      pendingId: "x",
      availabilityStatus: "DISPONIBLE_PARCIAL",
    });
    const b = fingerprintOf(EVENT_TYPE, {
      pendingId: "x",
      availabilityStatus: "DISPONIBLE_COMPLETO",
    });
    expect(a).not.toBe(b);
  });

  it("cambia cuando cambia el tipo de evento, con el mismo payload", () => {
    const payload = { pendingId: "x", availabilityStatus: "DISPONIBLE_PARCIAL" };
    expect(fingerprintOf("pending.availability.partial", payload)).not.toBe(
      fingerprintOf("pending.availability.full", payload),
    );
  });
});

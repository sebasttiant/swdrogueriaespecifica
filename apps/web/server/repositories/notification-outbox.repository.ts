// --------------------------------------------------------------------------
// Repositorio del outbox de notificaciones — ÚNICO lugar que toca Prisma para
// `NotificationOutbox`.
//
// Es la cola transaccional de avisos al dueño. Un evento se identifica por la
// TRANSICIÓN del agregado (recipient, aggregateType, aggregateId,
// transitionKey): reintentar la misma transición no duplica la notificación.
// `fingerprint` ata el contenido canónico (eventType + payload) a esa
// identidad — si la misma transición llega con otro contenido, es un error del
// llamador (igual que el command store).
//
// El outbox no sabe qué eventos de negocio existen: `eventType` es String
// libre. La lista crece con cada flujo y acoplarla acá obligaría a una
// migración por cada uno.
// --------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { prisma } from "@/lib/db/prisma";
import type { NotificationOutbox, Prisma } from "@/lib/generated/prisma/client";

/** Misma transición, contenido distinto: es un error del llamador. */
export class NotificationPayloadConflictError extends Error {
  constructor(public readonly eventType: string, public readonly aggregateId: string) {
    super(`notification ${eventType}/${aggregateId} was already enqueued with a different payload`);
    this.name = "NotificationPayloadConflictError";
  }
}

export type OutboxEventIdentity = {
  recipientId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  transitionKey: string;
};

export type EnqueueOutboxEventData = OutboxEventIdentity & {
  payload: Prisma.InputJsonValue;
};

/** SHA-256 del payload canónico: ata la identidad de transición al contenido. */
export function fingerprintOf(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/** El evento ya encolado para esa identidad, o null. */
export function findOutboxEvent(
  identity: OutboxEventIdentity,
  client: Prisma.TransactionClient = prisma,
): Promise<NotificationOutbox | null> {
  return client.notificationOutbox.findUnique({
    where: {
      recipientId_aggregateType_aggregateId_transitionKey: {
        recipientId: identity.recipientId,
        aggregateType: identity.aggregateType,
        aggregateId: identity.aggregateId,
        transitionKey: identity.transitionKey,
      },
    },
  });
}

/**
 * Encola un evento en la MISMA transacción que cambió el agregado.
 *
 * Reintentar la misma transición devuelve el evento ya encolado (replay) sin
 * duplicar. La misma transición con otro contenido es
 * `NotificationPayloadConflictError`.
 */
export async function enqueueOutboxEvent(
  data: EnqueueOutboxEventData & { fingerprint: string },
  client: Prisma.TransactionClient = prisma,
): Promise<NotificationOutbox> {
  const known = await findOutboxEvent(data, client);
  if (known) {
    if (known.fingerprint !== data.fingerprint) {
      throw new NotificationPayloadConflictError(data.eventType, data.aggregateId);
    }
    return known;
  }

  try {
    return await client.notificationOutbox.create({
      data: {
        recipientId: data.recipientId,
        eventType: data.eventType,
        aggregateType: data.aggregateType,
        aggregateId: data.aggregateId,
        transitionKey: data.transitionKey,
        fingerprint: data.fingerprint,
        payload: data.payload,
      },
    });
  } catch (error) {
    // Entre el find y el create se metió el reintento: si el payload coincide,
    // es replay; si no, conflicto.
    if (isUniqueViolation(error)) {
      const winner = await findOutboxEvent(data, client);
      if (winner) {
        if (winner.fingerprint !== data.fingerprint) {
          throw new NotificationPayloadConflictError(data.eventType, data.aggregateId);
        }
        return winner;
      }
    }
    throw error;
  }
}

/** Eventos listos para entregar, por antigüedad. */
export function listPendingOutboxEvents(
  limit: number,
  client: Prisma.TransactionClient = prisma,
): Promise<NotificationOutbox[]> {
  return client.notificationOutbox.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/** Marca el evento como entregado (transport in-app, at-least-once). */
export function markOutboxEventSent(
  id: string,
  client: Prisma.TransactionClient = prisma,
): Promise<NotificationOutbox> {
  return client.notificationOutbox.update({
    where: { id },
    data: { status: "SENT", sentAt: new Date() },
  });
}

/** Marca el evento como fallido e incrementa el contador de intentos. */
export function markOutboxEventFailed(
  id: string,
  lastError: string,
  client: Prisma.TransactionClient = prisma,
): Promise<NotificationOutbox> {
  return client.notificationOutbox.update({
    where: { id },
    data: {
      status: "FAILED",
      lastError,
      attempts: { increment: 1 },
    },
  });
}
// --------------------------------------------------------------------------
// Servicio del outbox de notificaciones (T5.1 — avisos al dueño).
//
// Encola EXACTAMENTE un evento por transición de disponibilidad, en la misma
// transacción que cambió el pendiente. El destinatario se deriva del agregado
// (el dueño que creó el pendiente), nunca del llamador: un `recipientIdOverride`
// se ignora — el servicio es el único que decide a quién avisar.
//
// El transporte es at-least-once e in-app (D5): la entrega puede repetirse y la
// presentación deduplica por la identidad del evento.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { NotificationOutbox, Prisma } from "@/lib/generated/prisma/client";
import {
  enqueueOutboxEvent,
  fingerprintOf,
  type EnqueueOutboxEventData,
} from "@/server/repositories/notification-outbox.repository";

export const AGGREGATE_TYPE_PENDING = "Pending";

export const NOTIFICATION_EVENT = {
  pendingAvailabilityPartial: "pending.availability.partial",
  pendingAvailabilityFull: "pending.availability.full",
} as const;

export type AvailabilityStatus = "DISPONIBLE_PARCIAL" | "DISPONIBLE_COMPLETO";

export type PendingAvailabilityNotification = {
  pendingId: string;
  availabilityStatus: AvailabilityStatus;
  /** Identifica la transición ÚNICA del pendiente (p.ej. el idempotencyKey del
   * flujo que cambió la disponibilidad). El reintento usa la misma clave. */
  transitionKey: string;
  /** A prueba de diseño: el servicio ignora este valor. */
  recipientIdOverride?: string;
};

/**
 * Encola la notificación de disponibilidad para el dueño del pendiente.
 *
 * Devuelve `null` cuando el pendiente no existe o no tiene dueño: no hay a quién
 * avisar y no es un error del llamador. Cualquier otra falla de lectura se
 * propaga — si el pendiente existe pero no se puede leer, el flujo debe saberlo.
 */
export async function enqueuePendingAvailabilityNotification(
  input: PendingAvailabilityNotification,
  client: Prisma.TransactionClient = prisma,
): Promise<NotificationOutbox | null> {
  const pending = await client.pending.findUnique({
    where: { id: input.pendingId },
    select: { id: true, createdById: true },
  });
  if (!pending || !pending.createdById) return null;

  const eventType =
    input.availabilityStatus === "DISPONIBLE_COMPLETO"
      ? NOTIFICATION_EVENT.pendingAvailabilityFull
      : NOTIFICATION_EVENT.pendingAvailabilityPartial;

  const payload = {
    pendingId: pending.id,
    availabilityStatus: input.availabilityStatus,
  };
  const fingerprint = fingerprintOf(payload);

  const data: EnqueueOutboxEventData = {
    recipientId: pending.createdById,
    eventType,
    aggregateType: AGGREGATE_TYPE_PENDING,
    aggregateId: pending.id,
    transitionKey: input.transitionKey,
    payload,
  };

  return enqueueOutboxEvent({ ...data, fingerprint }, client);
}
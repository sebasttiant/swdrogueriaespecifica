// --------------------------------------------------------------------------
// Servicio del outbox de notificaciones (T5.1 — avisos al dueño).
//
// Encola EXACTAMENTE un evento por transición de disponibilidad, en la misma
// transacción que cambió el pendiente.
//
// DOS COSAS LAS DECIDE ESTE SERVICIO Y NO EL LLAMADOR, y por la misma razón:
// una garantía que dependa de que el llamador se acuerde no es una garantía.
//
//   El destinatario sale del agregado —el vendedor que creó el pendiente—. No
//   hay parámetro para pasarlo: lo que no existe en la firma no se puede
//   equivocar.
//
//   La clave de transición sale del estado alcanzado. Si viniera de afuera, un
//   llamador que generara un UUID nuevo en cada intento haría que el índice
//   único no choque nunca: el dedupe se vería correcto en las pruebas y en
//   producción el dueño recibiría el mismo aviso una vez por reintento.
//
// El transporte externo es at-least-once; la presentación in-app lee el outbox
// directo y no depende de que nadie marque nada (D5).
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
};

/**
 * La transición ES el estado alcanzado.
 *
 * El pendiente ya identifica al agregado en la clave única, así que alcanza con
 * el estado para distinguir "pasó a parcial" de "pasó a completo" y para que un
 * reintento de la misma transición produzca la misma clave por construcción.
 *
 * Consecuencia buscada: si un pendiente vuelve a parcial después de haber
 * estado en parcial, no se avisa de nuevo. El vendedor ya sabe que hay stock
 * parcial; repetirlo es ruido, no información.
 */
function transitionKeyFor(availabilityStatus: AvailabilityStatus): string {
  return availabilityStatus;
}

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

  const data: EnqueueOutboxEventData = {
    recipientId: pending.createdById,
    eventType,
    aggregateType: AGGREGATE_TYPE_PENDING,
    aggregateId: pending.id,
    transitionKey: transitionKeyFor(input.availabilityStatus),
    payload,
  };

  return enqueueOutboxEvent(
    { ...data, fingerprint: fingerprintOf(eventType, payload) },
    client,
  );
}

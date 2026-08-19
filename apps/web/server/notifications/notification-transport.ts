// --------------------------------------------------------------------------
// Transport in-app del outbox de notificaciones (T5.1).
//
// D5: el MVP no tiene proveedor externo de notificaciones. El transport
// entrega los eventos a la presentación in-app con semántica at-least-once:
// cada evento se marca SENT al entregarlo, y la presentación deduplica por la
// identidad del evento (recipient/event/aggregate/transitionKey). Si un evento
// se entrega dos veces, la presentación muestra una sola notificación.
//
// La entrega es idempotente por diseño: `markOutboxEventSent` sobre un evento
// ya SENT no rompe nada — el siguiente ciclo simplemente no lo vuelve a tomar.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import {
  listPendingOutboxEvents,
  markOutboxEventSent,
} from "@/server/repositories/notification-outbox.repository";

/**
 * Entrega los eventos pendientes a la presentación in-app.
 *
 * At-least-once: si el proceso cae entre la entrega y el marcado SENT, el
 * evento se vuelve a tomar en el siguiente ciclo y la presentación deduplica.
 * Devuelve la cantidad de eventos entregados en esta corrida.
 */
export async function deliverInAppNotifications(
  limit = 50,
): Promise<number> {
  const pending = await listPendingOutboxEvents(limit);
  for (const event of pending) {
    // La entrega in-app es marcar como entregado: la lectura para la
    // presentación filtra por SENT. Sin proveedor externo no hay paso de red.
    await markOutboxEventSent(event.id);
  }
  return pending.length;
}

export type { NotificationOutbox } from "@/lib/generated/prisma/client";

/**
 * Notificaciones entregadas para un destinatario, listas para la presentación.
 *
 * La presentación deduplica por la identidad del evento: un mismo evento
 * entregado dos veces (at-least-once) se muestra una sola vez.
 */
export function listDeliveredNotifications(
  recipientId: string,
): Promise<{ id: string; eventType: string; payload: unknown; createdAt: Date }[]> {
  return prisma.notificationOutbox.findMany({
    where: { recipientId, status: "SENT" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      eventType: true,
      payload: true,
      createdAt: true,
    },
  });
}
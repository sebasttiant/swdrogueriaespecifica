// --------------------------------------------------------------------------
// Bandeja in-app de notificaciones (T5.1).
//
// D5: el MVP no tiene proveedor externo. Y sin proveedor externo NO HAY PASO DE
// ENTREGA: el evento encolado ya es la notificación, y la pantalla lo lee del
// outbox.
//
// Acá había un "transport" que leía los eventos PENDING y los marcaba SENT sin
// hacer nada más. Esa transición no entregaba nada —la entrega ERA el cambio de
// estado— y como la pantalla filtraba por SENT y nadie corría el ciclo, un
// evento encolado se quedaba en PENDING para siempre y el dueño no lo veía
// nunca. Se sacó: un paso que no hace nada pero del que la pantalla depende es
// peor que no tener paso.
//
// `status`, `attempts` y `lastError` siguen en el modelo porque describen a un
// transporte EXTERNO —el día que haya WhatsApp o correo, el drenador está en el
// repositorio: `listPendingOutboxEvents`, `markOutboxEventSent`,
// `markOutboxEventFailed`—. La bandeja in-app no los mira, y por eso un fallo
// de ese transporte futuro no puede borrar un aviso de la pantalla.
// --------------------------------------------------------------------------

import type { NotificationOutbox } from "@/lib/generated/prisma/client";
import {
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  MAX_NOTIFICATION_PAGE_SIZE,
  listRecipientNotifications,
} from "@/server/repositories/notification-outbox.repository";

export type { NotificationOutbox };

export type InboxNotification = {
  id: string;
  eventType: string;
  payload: unknown;
  createdAt: Date;
};

export type InboxPage = {
  items: InboxNotification[];
  /** `id` desde el cual pedir la página siguiente, o `null` si no hay más. */
  nextCursor: string | null;
};

function toInboxNotification(event: NotificationOutbox): InboxNotification {
  return {
    id: event.id,
    eventType: event.eventType,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

/**
 * Las notificaciones de una persona, de la más nueva a la más vieja.
 *
 * Pide una de más que el tamaño de página para saber si hay siguiente sin tener
 * que contar la tabla entera.
 */
export async function listInboxNotifications(
  recipientId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<InboxPage> {
  const limit = options.limit ?? DEFAULT_NOTIFICATION_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_NOTIFICATION_PAGE_SIZE) {
    throw new RangeError(
      `limit must be an integer between 1 and ${MAX_NOTIFICATION_PAGE_SIZE}, received ${limit}`,
    );
  }

  const rows = await listRecipientNotifications(recipientId, {
    limit: limit + 1,
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    items: page.map(toInboxNotification),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  };
}

// --------------------------------------------------------------------------
// Los avisos de llegada que el vendedor tiene que ver.
//
// La cadena existía completa y era INVISIBLE. `inventory-entry.service` encola
// el evento dentro de su propia transacción cuando bodega registra la entrada, y
// `notification-inbox` sabe leer la bandeja de una persona. Entre esas dos
// puntas no había nada: ninguna pantalla, acción ni servicio leía la bandeja, y
// el aviso se escribía en la base sin que el vendedor lo viera nunca.
//
// Este servicio es ese eslabón. No inventa el aviso —lo emite la entrada— ni lo
// entrega por fuera: lo traduce a lo que la pantalla puede mostrar.
//
// SOBRE "LEÍDO": no hay columna de leído y no se agrega una. El aviso deja de
// ser relevante cuando el vendedor hizo lo que el aviso le pedía, así que se
// ata al estado ACTUAL del pendiente. Una marca aparte puede quedar en `false`
// sobre un pendiente ya entregado y seguir gritando para siempre; el estado del
// pendiente no puede mentir sobre sí mismo. Además evita una migración, que
// sobre este backlog sin desplegar es riesgo que no hace falta correr.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@/lib/generated/prisma/client";
import { listInboxNotifications } from "@/server/notifications/notification-inbox";
import { NOTIFICATION_EVENT } from "@/server/services/notification-outbox.service";

/** Cuántos avisos mira la pantalla por defecto. */
export const DEFAULT_ARRIVAL_NOTICE_LIMIT = 10;

/**
 * Cuántos eventos se leen de la bandeja para llenar esos avisos.
 *
 * Es mayor que el techo de salida a propósito: la bandeja trae eventos de
 * pendientes que ya se cerraron, y esos se descartan acá. Sin holgura, una
 * racha de pendientes entregados dejaría la pantalla vacía teniendo avisos
 * vivos más abajo.
 */
const INBOX_SCAN_LIMIT = 50;

/** Los dos estados de disponibilidad sobre los que se avisa. */
const ESTADOS_CON_STOCK = ["DISPONIBLE_PARCIAL", "DISPONIBLE_COMPLETO"] as const;

/**
 * Un pendiente cerrado ya no necesita aviso: el vendedor hizo lo que tenía que
 * hacer, o el pedido murió. `PENDIENTE` y `PARCIAL` son los que siguen vivos.
 */
const ESTADOS_ABIERTOS = ["PENDIENTE", "PARCIAL"] as const;

export type ArrivalNotice = {
  pendingId: string;
  productName: string;
  /** Lo que el cliente pidió. */
  quantity: number;
  /** Lo que ya está reservado para él. */
  readyQuantity: number;
  availabilityStatus: "DISPONIBLE_PARCIAL" | "DISPONIBLE_COMPLETO";
  /** Nombre del cliente, cuando el pendiente lo tiene cargado. */
  customerName: string | null;
  /** Cuándo bodega informó la llegada. */
  noticedAt: Date;
};

/**
 * Los avisos vivos de una persona, del más viejo al más nuevo.
 *
 * El orden NO es cronológico inverso como en una bandeja de correo: acá el
 * primero es el que espera hace más tiempo. Es el mismo FIFO con el que se
 * atiende la cola, y la pantalla no puede contradecirlo — si el aviso más nuevo
 * quedara arriba, el vendedor llamaría primero al cliente que llegó último.
 */
export async function listArrivalNotices(
  recipientId: string,
  options: { limit?: number } = {},
): Promise<ArrivalNotice[]> {
  const limit = options.limit ?? DEFAULT_ARRIVAL_NOTICE_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`limit debe ser un entero positivo, se recibió ${limit}`);
  }

  const { items } = await listInboxNotifications(recipientId, {
    limit: INBOX_SCAN_LIMIT,
  });

  const avisados = items.filter(
    (evento) =>
      evento.eventType === NOTIFICATION_EVENT.pendingAvailabilityFull ||
      evento.eventType === NOTIFICATION_EVENT.pendingAvailabilityPartial,
  );
  if (avisados.length === 0) return [];

  // Un pendiente puede tener dos eventos —pasó a parcial y después a completo—.
  // Interesa el más viejo: es cuando el cliente empezó a esperar noticias.
  const primerAvisoPorPendiente = new Map<string, Date>();
  for (const evento of avisados) {
    const pendingId = pendingIdDe(evento.payload);
    if (!pendingId) continue;
    const previo = primerAvisoPorPendiente.get(pendingId);
    if (!previo || evento.createdAt < previo) {
      primerAvisoPorPendiente.set(pendingId, evento.createdAt);
    }
  }
  if (primerAvisoPorPendiente.size === 0) return [];

  // La verdad de si el aviso sigue vivo la tiene el pendiente, no el evento.
  const pendientes = await prisma.pending.findMany({
    where: {
      id: { in: [...primerAvisoPorPendiente.keys()] },
      createdById: recipientId,
      status: { in: [...ESTADOS_ABIERTOS] },
      availabilityStatus: { in: [...ESTADOS_CON_STOCK] },
    },
    select: {
      id: true,
      quantity: true,
      inventoryReadyQuantity: true,
      availabilityStatus: true,
      customerName: true,
      product: { select: { name: true } },
    },
  });

  return pendientes
    .map((pendiente) => ({
      pendingId: pendiente.id,
      productName: pendiente.product.name,
      quantity: pendiente.quantity,
      readyQuantity: pendiente.inventoryReadyQuantity,
      availabilityStatus:
        pendiente.availabilityStatus as ArrivalNotice["availabilityStatus"],
      customerName: pendiente.customerName,
      noticedAt: primerAvisoPorPendiente.get(pendiente.id) as Date,
    }))
    .sort((a, b) => a.noticedAt.getTime() - b.noticedAt.getTime())
    .slice(0, limit);
}

/**
 * El `pendingId` del payload, o `null` si el evento no lo trae.
 *
 * El payload es `Json` en la base: lo que entra tipado sale sin tipo, y un
 * evento viejo o de otra versión puede no tener la forma esperada. Se descarta
 * en vez de romper la pantalla entera por un registro.
 */
function pendingIdDe(payload: Prisma.JsonValue | unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const valor = (payload as { pendingId?: unknown }).pendingId;
  return typeof valor === "string" && valor.length > 0 ? valor : null;
}

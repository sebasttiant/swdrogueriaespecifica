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
import {
  AGGREGATE_TYPE_PENDING,
  NOTIFICATION_EVENT,
} from "@/server/services/notification-outbox.service";

/** Cuántos avisos mira la pantalla por defecto. */
export const DEFAULT_ARRIVAL_NOTICE_LIMIT = 10;

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
 * Los avisos vivos de una persona, del que espera hace más tiempo al más
 * reciente.
 *
 * EL ORDEN DE LA CONSULTA IMPORTA, y antes estaba al revés. Se leían los 50
 * eventos más nuevos de la bandeja y recién después se descartaban los de
 * pendientes ya cerrados. Un vendedor con volumen —sesenta pedidos atendidos
 * esta semana— dejaba de ver al cliente que espera desde el lunes: los eventos
 * nuevos gastaban el cupo y el aviso vivo quedaba afuera. Fallaba en silencio,
 * y justo cuando más movimiento hay.
 *
 * Ahora manda el pendiente. El conjunto de avisos vivos lo determina la tabla
 * de pendientes —míos, abiertos, con stock reservado—, que son decenas, no el
 * historial de eventos, que solo crece. El JOIN con el outbox cumple dos
 * funciones y ninguna es decorativa: aporta `noticedAt` y EXIGE que el evento
 * exista. Sin esa exigencia, un pendiente al que alguien le tocara la
 * disponibilidad a mano mostraría un aviso que nadie emitió.
 *
 * `MIN(createdAt)` es cuándo empezó la espera de ESE cliente: un pendiente que
 * pasó a parcial y después a completo tiene dos eventos, y el que importa es el
 * primero. El `LIMIT` cae sobre el conjunto ya filtrado, así que un pendiente
 * cerrado no puede volver a consumir el cupo de uno vivo.
 *
 * El aislamiento va por partida doble —`p."createdById"` y `n."recipientId"`—
 * porque son dos hechos distintos: quién tomó el pedido y a quién se le avisó.
 * Exigir los dos hace que ver la cola global no alcance para heredar el aviso
 * personal de otro vendedor.
 */
export async function listArrivalNotices(
  recipientId: string,
  options: { limit?: number } = {},
): Promise<ArrivalNotice[]> {
  const limit = options.limit ?? DEFAULT_ARRIVAL_NOTICE_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`limit debe ser un entero positivo, se recibió ${limit}`);
  }

  type Fila = {
    id: string;
    quantity: number;
    inventoryReadyQuantity: number;
    availabilityStatus: string;
    customerName: string | null;
    productName: string;
    noticedAt: Date;
  };

  // Los estados van como literales en el SQL —no como parámetros— porque son
  // constantes del dominio, no entrada de nadie. `::text` evita tener que
  // castear el enum en cada comparación.
  const filas = await prisma.$queryRaw<Fila[]>`
    SELECT p.id,
           p.quantity,
           p."inventoryReadyQuantity",
           p."availabilityStatus"::text AS "availabilityStatus",
           p."customerName",
           pr.name AS "productName",
           MIN(n."createdAt") AS "noticedAt"
      FROM pendings p
      JOIN products pr ON pr.id = p."productId"
      JOIN notification_outbox n
        ON n."aggregateType" = ${AGGREGATE_TYPE_PENDING}
       AND n."aggregateId" = p.id
       AND n."recipientId" = ${recipientId}
       AND n."eventType" IN (
             ${NOTIFICATION_EVENT.pendingAvailabilityPartial},
             ${NOTIFICATION_EVENT.pendingAvailabilityFull}
           )
     WHERE p."createdById" = ${recipientId}
       AND p.status::text IN ('PENDIENTE', 'PARCIAL')
       AND p."availabilityStatus"::text IN (
             'DISPONIBLE_PARCIAL', 'DISPONIBLE_COMPLETO'
           )
     GROUP BY p.id, pr.name
     ORDER BY MIN(n."createdAt") ASC, p.id ASC
     LIMIT ${limit}
  `;

  return filas.map((fila) => ({
    pendingId: fila.id,
    productName: fila.productName,
    quantity: fila.quantity,
    readyQuantity: fila.inventoryReadyQuantity,
    availabilityStatus: fila.availabilityStatus as ArrivalNotice["availabilityStatus"],
    customerName: fila.customerName,
    noticedAt: fila.noticedAt,
  }));
}

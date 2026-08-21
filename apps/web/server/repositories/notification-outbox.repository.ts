// --------------------------------------------------------------------------
// Repositorio del outbox de notificaciones — ÚNICO lugar que toca Prisma para
// `NotificationOutbox`. La lectura para la presentación también vive acá, no en
// el módulo de notificaciones: si el acceso se reparte, la regla deja de ser
// verificable.
//
// Es la cola transaccional de avisos al dueño. Un evento se identifica por la
// TRANSICIÓN del agregado (recipient, aggregateType, aggregateId,
// transitionKey): reintentar la misma transición no duplica la notificación.
// `fingerprint` ata el contenido canónico a esa identidad — si la misma
// transición llega con otro contenido, es un error del llamador (igual que el
// command store).
//
// `eventType` viaja DENTRO de la huella por la firma de `fingerprintOf`, no por
// convención del llamador. No está en el índice único a propósito: la identidad
// es la transición, no el tipo derivado de su resultado. Sin la huella, dos
// llamadores podrían encolar la misma transición con tipos distintos y el
// segundo recibiría el evento del primero sin enterarse.
//
// El outbox no sabe qué eventos de negocio existen: `eventType` es String
// libre. La lista crece con cada flujo y acoplarla acá obligaría a una
// migración por cada uno.
// --------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { prisma } from "@/lib/db/prisma";
import type { NotificationOutbox, Prisma } from "@/lib/generated/prisma/client";

/** Página por defecto de la bandeja in-app. */
export const DEFAULT_NOTIFICATION_PAGE_SIZE = 20;
/** Techo duro: sin él, un `limit` del llamador vuelve a abrir la consulta sin fin. */
export const MAX_NOTIFICATION_PAGE_SIZE = 100;
/** Intentos de un transporte externo antes de dar el evento por perdido. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Misma transición, contenido distinto: es un error del llamador. */
export class NotificationPayloadConflictError extends Error {
  constructor(public readonly eventType: string, public readonly aggregateId: string) {
    super(`notification ${eventType}/${aggregateId} was already enqueued with a different payload`);
    this.name = "NotificationPayloadConflictError";
  }
}

/**
 * Otra transacción encoló esta misma transición entre nuestra lectura y nuestra
 * escritura. El llamador tiene que REINTENTAR la transacción completa.
 *
 * Acá NO se resuelve si fue replay o conflicto, y no es una omisión: PostgreSQL
 * ABORTA la transacción entera al violar la unicidad, así que toda consulta
 * posterior con el mismo cliente falla con `25P02` hasta el ROLLBACK, y Prisma
 * no envuelve cada sentencia en un savepoint. Como el outbox existe para
 * encolarse DENTRO de la transacción que cambió el agregado, una recuperación
 * que consultara acá sería código muerto exactamente donde importa.
 *
 * Mismo criterio que `recordCommand` en el command store: el repositorio lanza,
 * y el reintento —con una transacción viva— resuelve el significado.
 */
export class NotificationEnqueueRaceError extends Error {
  constructor(public readonly eventType: string, public readonly aggregateId: string) {
    super(`notification ${eventType}/${aggregateId} lost the enqueue race; retry the transaction`);
    this.name = "NotificationEnqueueRaceError";
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

/** Ordena las claves de todo objeto anidado para que la huella no dependa del orden. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inner]) => [key, canonicalize(inner)]),
    );
  }
  return value;
}

/**
 * SHA-256 del contenido canónico: ata el tipo de evento Y el payload a la
 * identidad de transición.
 *
 * `eventType` es un parámetro propio y no una clave más del objeto para que no
 * se pueda olvidar: quien calcula una huella tiene que nombrarlo.
 */
export function fingerprintOf(eventType: string, payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(canonicalize({ eventType, payload }));
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
 * `NotificationPayloadConflictError`. Perder la carrera contra otra transacción
 * es `NotificationEnqueueRaceError`, y se reintenta la transacción entera.
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
    // Solo se le pone nombre: consultar acá es imposible. Ver
    // `NotificationEnqueueRaceError`.
    if (isUniqueViolation(error)) {
      throw new NotificationEnqueueRaceError(data.eventType, data.aggregateId);
    }
    throw error;
  }
}

/**
 * Toma un lote de eventos por entregar y los deja LOCKEADOS para esta
 * transacción. Exige transacción: el lock muere con ella.
 *
 * `SKIP LOCKED` es lo que permite más de un drenador. Sin él, dos procesos leen
 * el mismo lote y entregan dos veces el mismo aviso; con él, cada uno se lleva
 * un lote distinto y ninguno espera al otro.
 *
 * Los agotados quedan afuera: un evento que ya gastó sus intentos no vuelve a
 * tomarse, y `MAX_DELIVERY_ATTEMPTS` es lo que impide que un destinatario roto
 * ocupe el lote para siempre.
 */
export async function listPendingOutboxEvents(
  limit: number,
  client: Prisma.TransactionClient,
): Promise<NotificationOutbox[]> {
  const locked = await client.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "notification_outbox"
    WHERE "status" = 'PENDING' AND "attempts" < ${MAX_DELIVERY_ATTEMPTS}
    ORDER BY "createdAt" ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `;
  if (locked.length === 0) return [];

  return client.notificationOutbox.findMany({
    where: { id: { in: locked.map((row) => row.id) } },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Lo que la presentación in-app le muestra a una persona, del más nuevo al más
 * viejo y ACOTADO.
 *
 * No filtra por estado a propósito. El estado describe al transporte externo,
 * no a la persona: un evento que un proveedor no pudo entregar sigue siendo un
 * aviso válido en pantalla, y esconderlo detrás de `SENT` haría que un fallo
 * del transporte —o su ausencia— borre la notificación del dueño.
 *
 * El techo tampoco es opcional: sin él, esta consulta devuelve todo lo que esa
 * persona recibió en la historia del sistema, y esa lista solo puede crecer.
 */
// `async` a propósito: una función que devuelve promesa pero valida lanzando de
// forma síncrona obliga al llamador a envolverla en try/catch Y en catch de
// promesa. Acá todo error llega por rechazo.
export async function listRecipientNotifications(
  recipientId: string,
  options: { limit?: number; cursor?: string } = {},
  client: Prisma.TransactionClient = prisma,
): Promise<NotificationOutbox[]> {
  // El techo admite uno más que la página máxima: quien pagina pide una fila de
  // sondeo para saber si hay siguiente sin contar la tabla entera.
  const ceiling = MAX_NOTIFICATION_PAGE_SIZE + 1;
  const limit = options.limit ?? DEFAULT_NOTIFICATION_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit <= 0 || limit > ceiling) {
    throw new RangeError(
      `limit must be an integer between 1 and ${ceiling}, received ${limit}`,
    );
  }

  return client.notificationOutbox.findMany({
    where: { recipientId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });
}

/** Marca el evento como entregado por un transporte externo. */
export function markOutboxEventSent(
  id: string,
  client: Prisma.TransactionClient = prisma,
): Promise<NotificationOutbox> {
  return client.notificationOutbox.update({
    where: { id },
    data: { status: "SENT", sentAt: new Date() },
  });
}

/**
 * Registra un intento fallido de un transporte externo.
 *
 * Mientras queden intentos vuelve a `PENDING`, no a un estado terminal: un
 * evento que quedara en `FAILED` al primer tropiezo no lo tomaría más nadie
 * —`listPendingOutboxEvents` solo mira `PENDING`— y el aviso se perdería en
 * silencio. `FAILED` queda para cuando se agotaron los intentos, que es la
 * única situación en la que significa "esto necesita una persona".
 */
export async function markOutboxEventFailed(
  id: string,
  lastError: string,
  client: Prisma.TransactionClient = prisma,
): Promise<NotificationOutbox> {
  const current = await client.notificationOutbox.findUnique({
    where: { id },
    select: { attempts: true },
  });
  const attempts = (current?.attempts ?? 0) + 1;

  return client.notificationOutbox.update({
    where: { id },
    data: {
      status: attempts >= MAX_DELIVERY_ATTEMPTS ? "FAILED" : "PENDING",
      lastError,
      attempts,
    },
  });
}

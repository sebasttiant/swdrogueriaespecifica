// --------------------------------------------------------------------------
// Repositorio de lotes — ÚNICO lugar que toca Prisma para `ProductBatch`.
// Lectura paginada (cursor) por producto. Stock vendible por agregación SQL.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import {
  clampTake,
  decodeCursor,
  encodeCursor,
  type Paginated,
} from "@/lib/pagination";
import type { ProductBatch, Prisma } from "@/lib/generated/prisma/client";
import { EXPIRY_CRITICAL_DAYS, EXPIRY_WARNING_DAYS } from "@/lib/inventory/batch-status";

export type BatchListItem = Pick<
  ProductBatch,
  "id" | "batchCode" | "expiresAt" | "quantity" | "location" | "status"
>;

const LIST_SELECT = {
  id: true,
  batchCode: true,
  expiresAt: true,
  quantity: true,
  location: true,
  status: true,
} as const;

export async function listBatchesByProduct(params: {
  productId: string;
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<BatchListItem>> {
  const take = clampTake(params.take);
  const cursorId = params.cursor ? decodeCursor(params.cursor) : null;

  const rows = await prisma.productBatch.findMany({
    where: { productId: params.productId },
    take: take + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    // Los que vencen antes, primero (útil para revisar caducidades).
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    select: LIST_SELECT,
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.id) : null;

  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// Expiring batch counts — calendar-day Bogota boundaries (D3: all statuses).
// ---------------------------------------------------------------------------

const BOGOTA_TZ = "America/Bogota";

/**
 * Returns the YYYY-MM-DD string for `date` anchored to the Bogota calendar.
 * DST-safe: uses Intl, never hardcodes the UTC-5 offset.
 */
function bogotaYMD(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOGOTA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Returns the UTC Date representing the START of the Bogota calendar day
 * that is `offsetDays` ahead of `ref`'s Bogota calendar date.
 *
 * "Start" = UTC instant for Bogota midnight of that day, which equals UTC
 * midnight + 5h (Colombia is UTC-5, no DST).  We use UTC noon of the target
 * Bogota calendar day as representative instant, then derive the Bogota YMD,
 * then compute UTC midnight of that Bogota date + 5h (= Bogota 00:00).
 *
 * For Prisma WHERE clauses this function is used as the exclusive upper bound:
 *   expired:  expiresAt < startOfBogotaDay(today + 1)
 *   critical: expiresAt >= startOfBogotaDay(today + 1) AND < startOfBogotaDay(today + 31)
 *   warning:  expiresAt >= startOfBogotaDay(today + 31) AND < startOfBogotaDay(today + 91)
 */
function startOfBogotaDayOffset(ref: Date, offsetDays: number): Date {
  // UTC noon on the base Bogota calendar date (safely within that day in Bogota).
  const baseYMD = bogotaYMD(ref);
  const [y, m, d] = baseYMD.split("-").map(Number) as [number, number, number];
  const utcNoonBase = Date.UTC(y, m - 1, d, 12, 0, 0);
  // Shift by offsetDays and re-derive Bogota YMD.
  const shifted = new Date(utcNoonBase + offsetDays * 24 * 60 * 60 * 1000);
  const targetYMD = bogotaYMD(shifted);
  const [ty, tm, td] = targetYMD.split("-").map(Number) as [number, number, number];
  // Bogota midnight = UTC 05:00 (UTC-5, no DST).
  return new Date(Date.UTC(ty, tm - 1, td, 5, 0, 0));
}

export type ExpiringBatchCounts = {
  expired: number;
  critical: number;
  warning: number;
};

/**
 * Returns the count of batches in each expiry tier for the current Bogota
 * calendar day. Uses calendar-day boundaries (not timestamp arithmetic).
 *
 * D3 (CONFIRMED): counts ALL batches with quantity > 0, regardless of
 * BatchStatus (DISPONIBLE, CUARENTENA, RETENIDO). isSellable() is the
 * separate sell gate and remains UNCHANGED.
 *
 * Three parallel Prisma count() calls — no row loading, pure aggregation.
 */
export async function countExpiringBatches(
  ref: Date = new Date(),
): Promise<ExpiringBatchCounts> {
  // Exclusive upper boundaries for each tier:
  //   startDay+1 = start of tomorrow Bogota  → expiresAt < this means calendar date <= today
  //   startDay+31 = start of today+31 Bogota → expiresAt < this means calendar date <= today+30
  //   startDay+91 = start of today+91 Bogota → expiresAt < this means calendar date <= today+90
  const boundary1 = startOfBogotaDayOffset(ref, 1);  // exclusive upper for expired
  const boundary31 = startOfBogotaDayOffset(ref, EXPIRY_CRITICAL_DAYS + 1);  // exclusive upper for critical
  const boundary91 = startOfBogotaDayOffset(ref, EXPIRY_WARNING_DAYS + 1);   // exclusive upper for warning

  const [expired, critical, warning] = await Promise.all([
    // expired: calendar date <= today (Bogota)
    prisma.productBatch.count({
      where: { expiresAt: { lt: boundary1 }, quantity: { gt: 0 } },
    }),
    // critical: calendar date > today AND <= today+30 (Bogota)
    prisma.productBatch.count({
      where: {
        expiresAt: { gte: boundary1, lt: boundary31 },
        quantity: { gt: 0 },
      },
    }),
    // warning: calendar date > today+30 AND <= today+90 (Bogota)
    prisma.productBatch.count({
      where: {
        expiresAt: { gte: boundary31, lt: boundary91 },
        quantity: { gt: 0 },
      },
    }),
  ]);

  return { expired, critical, warning };
}

// ---------------------------------------------------------------------------
// Upsert de lote — solo se usa desde el service de entradas, dentro de $tx.
// Clave única: (productId, batchCode). Si el lote no existe lo crea con
// status DISPONIBLE; si ya existe, incrementa la cantidad sin tocar expiresAt.
// ---------------------------------------------------------------------------

export type UpsertBatchQuantityParams = {
  productId: string;
  batchCode: string;
  expiresAt: Date;
  quantity: number;
  /**
   * Laboratorio OBSERVADO al recibir el lote físico. Ausente cuando la
   * recepción no lo informa: en ese caso el lote conserva la evidencia que ya
   * tuviera, porque no informar no es lo mismo que informar "ninguno".
   */
  receivedLaboratoryId?: string | null;
};

/**
 * Evidencia de laboratorio del lote, con la RECEPCIÓN DE ESE LOTE serializada.
 *
 * DEBE llamarse dentro de una transacción y ANTES del upsert.
 *
 * El candado NO cuelga de la fila. `SELECT ... FOR UPDATE` bloquea filas, y la
 * primera recepción de un lote ocurre justamente cuando la fila todavía no
 * existe: dos recepciones simultáneas leían ambas `null`, las dos se creían la
 * primera, y si traían laboratorios distintos la segunda pisaba la evidencia de
 * la primera en silencio — exactamente lo que la regla de conflicto existe para
 * impedir. El `FOR UPDATE` es correcto para el lote que YA existe y no dice
 * nada sobre el hueco anterior.
 *
 * Por eso el candado cuelga del PAR que identifica al lote, con un advisory
 * lock TRANSACCIONAL: existe aunque la fila no exista, y se suelta solo al
 * cerrar la transacción, sin depender de que nadie lo libere a mano.
 *
 * La clave lleva la longitud del `productId` adelante para que la
 * concatenación sea inyectiva: sin eso, un `batchCode` que empiece con el final
 * de otro id podría producir la misma cadena que otro par. Una colisión de
 * `hashtextextended` solo haría que dos lotes distintos se serialicen de más;
 * nunca que uno se salte el candado.
 *
 * Devuelve `null` cuando el lote todavía no existe: no hay evidencia previa que
 * contradecir, y el upsert lo creará — pero ahora con la garantía de que nadie
 * más está haciendo lo mismo con el mismo par.
 *
 * El nombre viaja junto al id porque el mensaje de conflicto se le muestra a
 * una persona, y una persona no puede hacer nada con un cuid.
 */
export type LockedBatchLaboratoryEvidence = {
  id: string;
  receivedLaboratoryId: string | null;
  receivedLaboratoryName: string | null;
};

export async function lockBatchLaboratoryEvidence(
  client: Prisma.TransactionClient,
  params: { productId: string; batchCode: string },
): Promise<LockedBatchLaboratoryEvidence | null> {
  // Primero el candado del par. A partir de acá, ninguna otra transacción
  // avanza sobre este mismo lote hasta que esta termine.
  await client.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        length(${params.productId})::text || ':' ||
        ${params.productId} || ':' || ${params.batchCode},
        0
      )
    )
  `;

  // `FOR UPDATE OF pb` es obligatorio con el LEFT JOIN: sin el `OF`, Postgres
  // intentaría bloquear también `laboratories`, que no se está modificando.
  // Se conserva: para el lote que ya existe sigue siendo el lock correcto, y
  // cuesta nada teniendo ya el advisory.
  const rows = await client.$queryRaw<LockedBatchLaboratoryEvidence[]>`
    SELECT pb.id,
           pb."receivedLaboratoryId",
           l.name AS "receivedLaboratoryName"
    FROM product_batches pb
    LEFT JOIN laboratories l ON l.id = pb."receivedLaboratoryId"
    WHERE pb."productId" = ${params.productId}
      AND pb."batchCode" = ${params.batchCode}
    FOR UPDATE OF pb
  `;
  return rows[0] ?? null;
}

/**
 * Campos de evidencia que se escriben SOLO cuando la recepción informó un
 * laboratorio. Sin laboratorio no se escribe nada —ni siquiera
 * `laboratoryEvidence`— para no degradar a UNKNOWN una evidencia ya observada.
 */
function laboratoryEvidenceOf(params: UpsertBatchQuantityParams) {
  if (!params.receivedLaboratoryId) return {};
  return {
    receivedLaboratoryId: params.receivedLaboratoryId,
    laboratoryEvidence: "OBSERVED" as const,
  };
}

export async function upsertBatchQuantity(
  client: Prisma.TransactionClient,
  params: UpsertBatchQuantityParams,
) {
  return client.productBatch.upsert({
    where: {
      productId_batchCode: {
        productId: params.productId,
        batchCode: params.batchCode,
      },
    },
    create: {
      productId: params.productId,
      batchCode: params.batchCode,
      expiresAt: params.expiresAt,
      quantity: params.quantity,
      status: "DISPONIBLE",
      ...laboratoryEvidenceOf(params),
    },
    update: {
      quantity: { increment: params.quantity },
      // Solo se llega acá con evidencia compatible: el service ya rechazó el
      // conflicto. Escribir sobre un lote sin evidencia previa es registrar la
      // PRIMERA observación, no sobrescribir una anterior.
      ...laboratoryEvidenceOf(params),
    },
  });
}

/**
 * Removes units from the sellable balance of the batch that received them.
 * Allocations are reservations, so they must not remain available globally.
 */
export function reserveReceivedBatchQuantity(
  client: Prisma.TransactionClient,
  batchId: string,
  quantity: number,
) {
  return client.productBatch.update({
    where: { id: batchId },
    data: { quantity: { decrement: quantity } },
  });
}

// Stock vendible: DISPONIBLE + con stock + no vencido. SUM por SQL, no en JS.
// `client` permite leer el stock dentro de la misma transacción que lo consume
// (pending.service), manteniendo la lectura consistente con las escrituras.
export async function stockByProduct(
  productId: string,
  now: Date = new Date(),
  client: Prisma.TransactionClient = prisma,
): Promise<number> {
  const result = await client.productBatch.aggregate({
    where: {
      productId,
      status: "DISPONIBLE",
      quantity: { gt: 0 },
      expiresAt: { gt: now },
    },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? 0;
}

/**
 * Units a new Pending can claim, WITHOUT touching physical stock.
 *
 * Registering a customer request must never move `product_batches.quantity`:
 * that column is the physical count of what is on the shelf. Decrementing it
 * because a customer asked for something made the pharmacy's inventory drift
 * downwards with no sale behind it.
 *
 * What must not happen twice is promising the SAME units to two customers, and
 * that is solved by reading: the units already committed to other open Pendings
 * are subtracted from the readable stock. The lot rows are locked — selected,
 * never written — so two simultaneous registrations of the same product cannot
 * both claim the same remainder.
 */
export async function claimableStockForPending(
  client: Prisma.TransactionClient,
  productId: string,
  requestedQuantity: number,
  now: Date = new Date(),
): Promise<number> {
  await client.$queryRaw`
    SELECT id FROM product_batches
    WHERE "productId" = ${productId} AND status = 'DISPONIBLE'
      AND quantity > 0 AND "expiresAt" > ${now}
    ORDER BY "expiresAt" ASC, id ASC FOR UPDATE
  `;

  const physical = await stockByProduct(productId, now, client);
  const committed = await client.pending.aggregate({
    // T2.2b: un cierre parcial es terminal y no compromete stock.
    where: { productId, status: { notIn: ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"] } },
    _sum: { inventoryReadyQuantity: true },
  });

  const free = Math.max(physical - (committed._sum.inventoryReadyQuantity ?? 0), 0);
  return Math.min(requestedQuantity, free);
}

export async function reserveBatchForPending(
  client: Prisma.TransactionClient,
  pendingId: string,
  batchId: string,
  quantity: number,
) {
  return client.pendingInventoryReservation.upsert({
    where: { pendingId_batchId: { pendingId, batchId } },
    create: { pendingId, batchId, quantity },
    update: { quantity: { increment: quantity } },
  });
}

/**
 * Frees every unconsumed commitment of a Pending so those units become
 * claimable again by other customers.
 *
 * It clears the ledger and nothing else. Physical lots are deliberately left
 * untouched: a commitment never decremented them, so incrementing them here
 * would invent stock that was never on the shelf.
 */
export async function releasePendingReservations(
  client: Prisma.TransactionClient,
  pendingId: string,
): Promise<number> {
  const reservations = await client.pendingInventoryReservation.findMany({
    where: { pendingId },
  });
  if (reservations.length === 0) return 0;

  await client.pendingInventoryReservation.deleteMany({ where: { pendingId } });
  return reservations.reduce((total, reservation) => total + reservation.quantity, 0);
}

/** Consumes reserved lots FIFO when the customer receives units. */
export async function consumePendingReservations(
  client: Prisma.TransactionClient,
  pendingId: string,
  quantity: number,
): Promise<void> {
  const reservations = (await client.pendingInventoryReservation.findMany({
    where: { pendingId }, orderBy: { createdAt: "asc" },
  })) ?? [];
  // Rows created before the reservation ledger have no lot traceability. They
  // remain deliverable; only new reservations may consume this ledger.
  if (reservations.length === 0) return;
  let remaining = quantity;
  for (const reservation of reservations) {
    if (remaining === 0) break;
    const consumed = Math.min(reservation.quantity, remaining);
    if (consumed === reservation.quantity) {
      await client.pendingInventoryReservation.delete({ where: { id: reservation.id } });
    } else {
      await client.pendingInventoryReservation.update({
        where: { id: reservation.id }, data: { quantity: { decrement: consumed } },
      });
    }
    remaining -= consumed;
  }
  if (remaining !== 0) throw new Error("Pending reservation invariant violated");
}

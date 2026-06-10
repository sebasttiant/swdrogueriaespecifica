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

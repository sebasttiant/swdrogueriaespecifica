// --------------------------------------------------------------------------
// Estado DERIVADO de un lote — funciones puras (sin DB, sin I/O).
//
// Regla: lo que decide el reloj ("vencido", "por vencer") o la cantidad
// ("agotado") se CALCULA acá; nunca se guarda en la base. El `status` humano
// (DISPONIBLE/CUARENTENA/RETENIDO) sí vive en la base.
//
// expiryLevel: classification by CALENDAR DAY in America/Bogota.
// isSellable:  separate transactional sell gate (timestamp-based, UNCHANGED).
// --------------------------------------------------------------------------

import type { BatchStatus } from "@/lib/generated/prisma/client";

// Ventana de alerta de vencimiento: dos umbrales de calendario, en días.
export const EXPIRY_WARNING_DAYS = 90; // > today+30 AND <= today+90
export const EXPIRY_CRITICAL_DAYS = 30; // > today AND <= today+30

const BOGOTA_TZ = "America/Bogota";

// 4-tier expiry classification (calendar-day, Bogota):
//   expired  = expiresAt calendar date <= today (Bogota)
//   critical = calendar date > today AND <= today+30 days
//   warning  = calendar date > today+30 AND <= today+90 days
//   ok       = calendar date > today+90 days
export type ExpiryLevel = "expired" | "critical" | "warning" | "ok";

/**
 * Returns the YYYY-MM-DD string for `date` anchored to the Bogota calendar.
 * Uses Intl (DST-safe, no hardcoded offset).
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
 * Adds `days` calendar days to the Bogota date represented by `ymd` and
 * returns the result as a YYYY-MM-DD string.
 *
 * Uses UTC noon (12:00Z) as representative instant so the Bogota calendar
 * date (UTC-5 = 07:00 Bogota) is always within the target calendar day.
 */
function addBogotaCalendarDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  // UTC noon on the base Bogota date = safely inside that calendar day in Bogota.
  const utcNoon = Date.UTC(y, m - 1, d, 12, 0, 0);
  const shifted = new Date(utcNoon + days * 24 * 60 * 60 * 1000);
  return bogotaYMD(shifted);
}

/**
 * Classifies the expiry tier of a batch by comparing its expiresAt CALENDAR
 * DATE in Bogota against today's calendar date in Bogota plus offsets.
 *
 * First-match ordering:
 *   1. expiresAt calendar date (Bogota) <= today → "expired"
 *   2. <= today + 30 calendar days              → "critical"
 *   3. <= today + 90 calendar days              → "warning"
 *   4. else                                     → "ok"
 *
 * NOTE: isSellable() is a SEPARATE concern (timestamp-based sell gate).
 * Do NOT conflate the two — this function is for DISPLAY/ALERTING only.
 */
export function expiryLevel(
  expiresAt: Date,
  now: Date = new Date(),
): ExpiryLevel {
  const expiresYMD = bogotaYMD(expiresAt);
  const todayYMD = bogotaYMD(now);
  const critical30YMD = addBogotaCalendarDays(todayYMD, EXPIRY_CRITICAL_DAYS);
  const warning90YMD = addBogotaCalendarDays(todayYMD, EXPIRY_WARNING_DAYS);

  if (expiresYMD <= todayYMD) return "expired";
  if (expiresYMD <= critical30YMD) return "critical";
  if (expiresYMD <= warning90YMD) return "warning";
  return "ok";
}

export function isAgotado(quantity: number): boolean {
  return quantity <= 0;
}

// ---------------------------------------------------------------------------
// isSellable — UNCHANGED. Transactional sell gate (timestamp-based).
//
// This is the SEPARATE sell gate at point of transaction:
//   DISPONIBLE && qty > 0 && expiresAt > now (timestamp comparison).
//
// "critical" tier does NOT affect sellability — it is an informational display
// tier only. A batch expiring in 15 days is critical for alerts but still
// sellable at the counter (DISPONIBLE + qty > 0 + not timestamp-expired).
// ---------------------------------------------------------------------------
export function isSellable(
  batch: { status: BatchStatus; quantity: number; expiresAt: Date },
  now: Date = new Date(),
): boolean {
  return (
    batch.status === "DISPONIBLE" &&
    batch.quantity > 0 &&
    batch.expiresAt.getTime() > now.getTime()
  );
}

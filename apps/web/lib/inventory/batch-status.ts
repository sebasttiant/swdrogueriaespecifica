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

// 5-tier expiry classification (calendar-day, Bogota):
//   expired  = expiresAt calendar date <= today (Bogota)
//   critical = calendar date > today AND <= today+30 days
//   warning  = calendar date > today+30 AND <= today+90 days
//   ok       = calendar date > today+90 days
//   unknown  = expiresAt is NULL
//
// `unknown` es un nivel del MISMO vocabulario y no una excepción aparte a
// propósito: así el compilador obliga a cada mapa de la pantalla a nombrarlo, y
// ningún sitio puede caer en silencio en "expired" por no haberlo previsto. Un
// lote sin fecha es lo que nadie sabe cuándo vence, que es otra cosa que un
// lote vencido: se sigue vendiendo y no entra en ningún aviso.
export type ExpiryLevel =
  | "expired"
  | "critical"
  | "warning"
  | "ok"
  | "unknown";

// Las tres franjas que se ALERTAN, en orden de urgencia. Es `ExpiryLevel` sin
// "ok": un lote vigente no es un aviso, y ofrecerlo como pestaña sería una
// cuarta lista que nadie abre.
//
// Deliberadamente el MISMO vocabulario que `ExpiryLevel`, no uno paralelo: la
// pantalla, el chip y la consulta nombran la franja con la misma palabra, así
// que no hay tabla de traducción que se desincronice. Las etiquetas en español
// viven en `features/vencimientos/expiry-tier.ts` — lib queda sin idioma.
export const EXPIRY_TIERS = ["expired", "critical", "warning"] as const;

export type ExpiryTier = (typeof EXPIRY_TIERS)[number];

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
 *   0. expiresAt === null                        → "unknown"
 *   1. expiresAt calendar date (Bogota) <= today → "expired"
 *   2. <= today + 30 calendar days              → "critical"
 *   3. <= today + 90 calendar days              → "warning"
 *   4. else                                     → "ok"
 *
 * NOTE: isSellable() is a SEPARATE concern (timestamp-based sell gate).
 * Do NOT conflate the two — this function is for DISPLAY/ALERTING only.
 */
export function expiryLevel(
  expiresAt: Date | null,
  now: Date = new Date(),
): ExpiryLevel {
  // Sin fecha no hay nada que comparar. Devolver "expired" acá haría
  // desaparecer de la góndola un stock que nadie sacó del estante.
  if (expiresAt === null) return "unknown";

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
//   DISPONIBLE && qty > 0 && (expiresAt === null || expiresAt > now).
//
// `expiresAt` NULL es vencimiento DESCONOCIDO, y desconocido NO es vencido: la
// mercadería está en el estante y se vende. Tratarlo como vencido sería hacer
// desaparecer stock real por un dato que la caja no traía impreso.
//
// "critical" tier does NOT affect sellability — it is an informational display
// tier only. A batch expiring in 15 days is critical for alerts but still
// sellable at the counter (DISPONIBLE + qty > 0 + not timestamp-expired).
// ---------------------------------------------------------------------------
export function isSellable(
  batch: { status: BatchStatus; quantity: number; expiresAt: Date | null },
  now: Date = new Date(),
): boolean {
  return (
    batch.status === "DISPONIBLE" &&
    batch.quantity > 0 &&
    (batch.expiresAt === null || batch.expiresAt.getTime() > now.getTime())
  );
}

/**
 * Días de CALENDARIO Bogotá entre hoy y el vencimiento del lote.
 *
 *   > 0   faltan tantos días
 *   = 0   vence hoy
 *   < 0   venció hace tantos días
 *   null  no se sabe cuándo vence
 *
 * Calendario y no milisegundos, a propósito: un lote que vence "mañana" tiene
 * que decir 1 tanto a las 8 de la mañana como a las 11 de la noche. Restar
 * instantes daría 0 en el segundo caso y la lista se contradiría con
 * `expiryLevel`, que ya razona por día de calendario.
 *
 * Se compara al MEDIODÍA UTC de cada fecha Bogotá: ese instante siempre cae
 * dentro de su propio día de calendario, así que la resta nunca queda a un pelo
 * del borde.
 */
export function bogotaCalendarDaysUntil(
  expiresAt: Date | null,
  now: Date = new Date(),
): number | null {
  // Sin fecha no hay cuenta que dar. Se devuelve `null` y no un número grande
  // para que la pantalla tenga que decidir qué escribir: cualquier número
  // afirmaría un plazo que nadie conoce.
  if (expiresAt === null) return null;

  const utcNoonOf = (ymd: string): number => {
    const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d, 12, 0, 0);
  };

  const diffMs = utcNoonOf(bogotaYMD(expiresAt)) - utcNoonOf(bogotaYMD(now));
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

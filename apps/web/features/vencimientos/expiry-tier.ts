// --------------------------------------------------------------------------
// Vocabulario en español de las franjas de vencimiento.
//
// PURO: no toca Prisma ni el reloj. La pantalla lo usa para leer la URL y
// pintarse; el chip de la barra de alertas lo usa para construir su enlace.
//
// Las franjas y sus umbrales viven en `lib/inventory/batch-status.ts`
// (`EXPIRY_TIERS`, 30 y 90 días). Acá solo se les pone nombre: lib queda sin
// idioma, igual que `BatchList` ya hacía con `ExpiryLevel`.
// --------------------------------------------------------------------------

import {
  EXPIRY_CRITICAL_DAYS,
  EXPIRY_TIERS,
  EXPIRY_WARNING_DAYS,
  type ExpiryTier,
} from "@/lib/inventory/batch-status";

export const VENCIMIENTOS_PATH = "/vencimientos";

export const EXPIRY_TIER_LABELS: Record<ExpiryTier, string> = {
  expired: "Vencidos",
  critical: `Críticos (${EXPIRY_CRITICAL_DAYS} d)`,
  warning: `Por vencer (${EXPIRY_WARNING_DAYS} d)`,
};

// Qué ventana cubre cada franja, con todas las letras. "Críticos" no le dice
// nada a nadie la primera vez; "vencen dentro de los próximos 30 días" sí.
export const EXPIRY_TIER_DESCRIPTIONS: Record<ExpiryTier, string> = {
  expired: "Ya pasaron su fecha de vencimiento. No se pueden vender.",
  critical: `Vencen dentro de los próximos ${EXPIRY_CRITICAL_DAYS} días.`,
  warning: `Vencen entre ${EXPIRY_CRITICAL_DAYS + 1} y ${EXPIRY_WARNING_DAYS} días — el aviso con tres meses de antelación.`,
};

export const EXPIRY_TIER_TONE: Record<ExpiryTier, "danger" | "warning"> = {
  expired: "danger",
  critical: "danger",
  warning: "warning",
};

// Un vacío genérico hace dudar de si la pantalla cargó. Cada franja dice qué
// significa estar vacía, que acá es una buena noticia.
export const EXPIRY_TIER_EMPTY: Record<
  ExpiryTier,
  { title: string; description: string }
> = {
  expired: {
    title: "No hay lotes vencidos",
    description: "Ningún lote con existencias pasó su fecha de vencimiento.",
  },
  critical: {
    title: "Nada vence este mes",
    description: `Ningún lote con existencias vence dentro de los próximos ${EXPIRY_CRITICAL_DAYS} días.`,
  },
  warning: {
    title: "Nada vence en los próximos tres meses",
    description: `Ningún lote con existencias vence entre ${EXPIRY_CRITICAL_DAYS + 1} y ${EXPIRY_WARNING_DAYS} días.`,
  },
};

/**
 * Lee el `?tier=` de la URL.
 *
 * Cualquier valor desconocido cae en `expired`, la franja MÁS urgente. El
 * parámetro es input del usuario y termina en una consulta: `?tier=cualquiera`
 * tiene que dar una lista válida, nunca un error ni la franja equivocada.
 */
export function resolveExpiryTier(raw?: string | null): ExpiryTier {
  return EXPIRY_TIERS.includes(raw as ExpiryTier)
    ? (raw as ExpiryTier)
    : "expired";
}

/**
 * Enlace a la pantalla de vencimientos.
 *
 * La franja viaja SIEMPRE, incluso la que es default: un enlace que depende de
 * cuál sea el default de hoy deja de apuntar a lo mismo el día que ese default
 * cambie.
 */
export function vencimientosHref(params: {
  tier: ExpiryTier;
  cursor?: string | null;
}): string {
  const query = new URLSearchParams({ tier: params.tier });
  if (params.cursor) query.set("cursor", params.cursor);
  return `${VENCIMIENTOS_PATH}?${query.toString()}`;
}

/**
 * Cómo se lee la cuenta de días en la fila.
 *
 * El signo lo dice todo y la frase no lo esconde: lo vencido dice "venció", lo
 * que falta dice "faltan". Un "-5 días" en una columna obliga a interpretar un
 * signo menos, y a las 9 de la mañana con 40 lotes en pantalla nadie lo hace.
 */
export function expiryCountdownLabel(days: number): string {
  if (days < 0) {
    const ago = Math.abs(days);
    return ago === 1 ? "Venció ayer" : `Venció hace ${ago} días`;
  }
  if (days === 0) return "Vence hoy";
  return days === 1 ? "Vence mañana" : `Faltan ${days} días`;
}

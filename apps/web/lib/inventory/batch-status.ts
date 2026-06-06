// --------------------------------------------------------------------------
// Estado DERIVADO de un lote — funciones puras (sin DB, sin I/O).
//
// Regla: lo que decide el reloj ("vencido", "por vencer") o la cantidad
// ("agotado") se CALCULA acá; nunca se guarda en la base. El `status` humano
// (DISPONIBLE/CUARENTENA/RETENIDO) sí vive en la base.
// --------------------------------------------------------------------------

import type { BatchStatus } from "@/lib/generated/prisma/client";

// Ventana de alerta de vencimiento (MVP: umbral único conservador de pharma).
export const EXPIRY_WARNING_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ok = vence más allá de la ventana · warning = vence dentro de la ventana ·
// expired = ya venció (o vence ahora mismo).
export type ExpiryLevel = "ok" | "warning" | "expired";

export function expiryLevel(
  expiresAt: Date,
  now: Date = new Date(),
): ExpiryLevel {
  if (expiresAt.getTime() <= now.getTime()) return "expired";
  const warningEdge = now.getTime() + EXPIRY_WARNING_DAYS * MS_PER_DAY;
  if (expiresAt.getTime() <= warningEdge) return "warning";
  return "ok";
}

export function isAgotado(quantity: number): boolean {
  return quantity <= 0;
}

// Stock vendible: decisión humana DISPONIBLE + con stock + no vencido.
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

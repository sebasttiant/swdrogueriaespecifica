// --------------------------------------------------------------------------
// Motivos por los que un pendiente se capturó SIN el código de Orion (D7).
//
// Lista CERRADA a propósito: con texto libre la cola de revisión no se puede
// contar, y sin contarla nadie sabe si la exigencia estorba o si Orion se cae
// seguido. La nota opcional existe justamente para lo que no entra en la lista.
//
// Los códigos son estables y coinciden con el enum `PendingIdentityDeferral`
// de la base; las etiquetas viven acá al lado pero SEPARADAS, porque cambiar
// cómo se lee un motivo en pantalla no puede cambiar lo que quedó guardado.
//
// PURO: no toca Prisma ni el reloj. El schema Zod lo usa para validar y la
// pantalla para pintar el selector, igual que `management-status.ts`.
// --------------------------------------------------------------------------

export const PENDING_IDENTITY_DEFERRAL_REASONS = [
  "ORION_UNAVAILABLE",
  "CODE_NOT_FOUND",
  "CODE_ALREADY_ASSIGNED",
  "OTHER",
] as const;

export type PendingIdentityDeferralReason =
  (typeof PENDING_IDENTITY_DEFERRAL_REASONS)[number];

// Redactadas desde el mostrador: describen lo que le pasó al vendedor, no el
// estado interno del sistema.
export const PENDING_IDENTITY_DEFERRAL_LABELS: Record<
  PendingIdentityDeferralReason,
  string
> = {
  ORION_UNAVAILABLE: "Orion no responde",
  CODE_NOT_FOUND: "No encuentro el código",
  CODE_ALREADY_ASSIGNED: "El código ya está en otro producto",
  OTHER: "Otro motivo",
};

/** Longitud máxima de la nota; la columna es TEXT, esto frena un pegado entero. */
export const MAX_IDENTITY_DEFERRAL_NOTE_LENGTH = 280;

export function isPendingIdentityDeferralReason(
  value: unknown,
): value is PendingIdentityDeferralReason {
  return (
    typeof value === "string" &&
    (PENDING_IDENTITY_DEFERRAL_REASONS as readonly string[]).includes(value)
  );
}

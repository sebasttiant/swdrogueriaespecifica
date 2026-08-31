// --------------------------------------------------------------------------
// Motivos por los que un pendiente se capturó SIN el código de Orión (D7).
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

import type { PendingIdentityDeferral } from "@/lib/generated/prisma/client";

// El `satisfies` ata esta lista al enum de la base en tiempo de COMPILACIÓN.
// Un comentario que dice "coinciden" no impide que dejen de coincidir; esto
// sí: agregar un motivo en Prisma y olvidarlo acá —o al revés— rompe el
// typecheck. El import es de tipo, así que se borra al compilar y no arrastra
// nada de Prisma a este módulo puro.
// `NEW_PRODUCT` va PRIMERO a propósito. Los otros cuatro describen un fracaso
// al conseguir el código; este describe que el código todavía no existe, que es
// el caso más común al dar de alta productos. Ponerlo último obligaría a leer
// tres motivos que no aplican antes de encontrar el que sí.
export const PENDING_IDENTITY_DEFERRAL_REASONS = [
  "NEW_PRODUCT",
  "ORION_UNAVAILABLE",
  "CODE_NOT_FOUND",
  "CODE_ALREADY_ASSIGNED",
  "OTHER",
] as const satisfies readonly PendingIdentityDeferral[];

export type PendingIdentityDeferralReason =
  (typeof PENDING_IDENTITY_DEFERRAL_REASONS)[number];

// Redactadas desde el mostrador: describen lo que le pasó al vendedor, no el
// estado interno del sistema.
export const PENDING_IDENTITY_DEFERRAL_LABELS: Record<
  PendingIdentityDeferralReason,
  string
> = {
  NEW_PRODUCT: "Producto nuevo, aún sin SKU",
  ORION_UNAVAILABLE: "Orión no responde",
  CODE_NOT_FOUND: "No encuentro el código",
  CODE_ALREADY_ASSIGNED: "El código ya está en otro producto",
  OTHER: "Otro motivo",
};

/** Longitud máxima de la nota; la columna es TEXT, esto frena un pegado entero. */
export const MAX_IDENTITY_DEFERRAL_NOTE_LENGTH = 280;

// El `satisfies` de arriba impide que SOBRE un motivo; esto impide que FALTE.
//
// Sin las dos direcciones, agregar un valor al enum de la base y olvidarlo acá
// compilaría igual, y el motivo nuevo sería invisible para el validador y para
// el selector: quedaría guardado en filas que la pantalla no sabe nombrar.
//
// La restricción `T extends never` es lo que hace fallar el typecheck. Un
// alias condicional NO sirve: resolvería a un tipo cualquiera sin quejarse.
type AssertNever<T extends never> = T;
type _EveryDatabaseReasonIsListed = AssertNever<
  Exclude<PendingIdentityDeferral, PendingIdentityDeferralReason>
>;

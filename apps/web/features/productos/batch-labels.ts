// --------------------------------------------------------------------------
// Cómo se LEEN el lote y el vencimiento de un lote en pantalla.
//
// PURO: no toca Prisma ni el reloj.
//
// Existe por el código reservado. "SIN LOTE 2027-01-15" es la representación
// interna de una caja que llegó sin número de lote impreso (ver
// `lib/inventory/reserved-batch-code.ts`); mostrarlo tal cual haría que alguien
// saliera a buscar al estante un lote que no existe, y además repetiría la
// fecha que ya está en su propia columna.
//
// La forma se decide con el MISMO predicado que la validación y el
// repositorio: si acá se reconociera el código reservado de otra manera, la
// pantalla y la base dejarían de hablar de lo mismo.
//
// Las reglas y los umbrales viven en `lib/inventory` — lib queda sin idioma,
// igual que `features/vencimientos/expiry-tier.ts` ya hacía con las franjas.
// --------------------------------------------------------------------------

import { formatBogotaDate } from "@/lib/datetime/bogota";
import {
  hasReservedBatchCodeShape,
  normalizeBatchCode,
} from "@/lib/inventory/reserved-batch-code";

export const SIN_LOTE_LABEL = "Sin lote";
export const SIN_VENCIMIENTO_LABEL = "Sin vencimiento";

/** El código de lote como se lee suelto (una celda de tabla, una lista). */
export function batchCodeLabel(batchCode: string): string {
  return hasReservedBatchCodeShape(normalizeBatchCode(batchCode))
    ? SIN_LOTE_LABEL
    : batchCode;
}

/**
 * El código de lote como TÍTULO de una fila.
 *
 * El prefijo "Lote" solo va con un lote de verdad: "Lote Sin lote" no se le
 * dice a nadie.
 */
export function batchCodeTitle(batchCode: string): string {
  const label = batchCodeLabel(batchCode);
  return label === SIN_LOTE_LABEL ? label : `Lote ${label}`;
}

/** El vencimiento como se lee suelto (una celda bajo el encabezado "Vence"). */
export function batchExpiryLabel(expiresAt: Date | null): string {
  return expiresAt === null
    ? SIN_VENCIMIENTO_LABEL
    : formatBogotaDate(expiresAt, { style: "date" });
}

/**
 * El vencimiento anunciado dentro de una línea de datos.
 *
 * Sin fecha se omite el "Vence": "Vence: Sin vencimiento" se contradice solo.
 */
export function batchExpiryTitle(expiresAt: Date | null): string {
  return expiresAt === null
    ? SIN_VENCIMIENTO_LABEL
    : `Vence: ${batchExpiryLabel(expiresAt)}`;
}

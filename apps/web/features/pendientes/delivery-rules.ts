import type { PendingStatus } from "@/lib/generated/prisma/client";

// --------------------------------------------------------------------------
// Reglas puras del ciclo de vida de entrega de un Pendiente (Slice A).
//
// PURAS: no tocan Prisma ni el reloj global. El service las usa dentro de una
// transacción para decidir el próximo estado; la UI las usa para mostrar el
// progreso. Nunca importar Prisma client acá.
// --------------------------------------------------------------------------

export type DeliveryRejection =
  | "ALREADY_DELIVERED"
  | "ALREADY_CANCELLED"
  | "NON_POSITIVE_QUANTITY"
  | "EXCEEDS_REMAINING"
  | "NOT_OWNER"
  | "NOT_INVOICED";

/** Cantidad restante por entregar. Nunca negativa. */
export function remainingQuantity(quantity: number, deliveredQuantity: number): number {
  return Math.max(quantity - deliveredQuantity, 0);
}

/**
 * Próximo estado del pendiente según lo entregado hasta ahora:
 *   0 entregado           -> PENDIENTE
 *   0 < entregado < total -> PARCIAL
 *   entregado >= total    -> ENTREGADO
 */
export function nextPendingStatus(
  quantity: number,
  deliveredQuantity: number,
): PendingStatus {
  if (deliveredQuantity <= 0) return "PENDIENTE";
  if (deliveredQuantity >= quantity) return "ENTREGADO";
  return "PARCIAL";
}

export type ValidateDeliveryInput = {
  status: PendingStatus;
  quantity: number;
  deliveredQuantity: number;
  deliverQuantity: number;
  invoicedQuantity?: number;
  customerStatus?: string;
};

/**
 * Valida una entrega ANTES de escribirla. Devuelve el rechazo o `null` si es
 * válida. Orden de chequeo: estado terminal primero (ENTREGADO/CANCELADO),
 * luego forma de la cantidad (entero positivo), luego el límite de lo que
 * queda por entregar.
 */
export function validateDelivery(
  input: ValidateDeliveryInput,
): DeliveryRejection | null {
  if (input.status === "ENTREGADO") return "ALREADY_DELIVERED";
  if (input.status === "CANCELADO") return "ALREADY_CANCELLED";
  if (input.customerStatus !== undefined && input.customerStatus !== "FACTURADO") return "NOT_INVOICED";

  if (
    !Number.isInteger(input.deliverQuantity) ||
    input.deliverQuantity <= 0
  ) {
    return "NON_POSITIVE_QUANTITY";
  }

  const remaining = Math.min(remainingQuantity(input.quantity, input.deliveredQuantity), (input.invoicedQuantity ?? input.quantity) - input.deliveredQuantity);
  if (input.deliverQuantity > remaining) return "EXCEEDS_REMAINING";

  return null;
}

/**
 * Valida una cancelación. Un pendiente ya ENTREGADO es un compromiso
 * cumplido: cancelarlo retroactivamente no tiene sentido de negocio.
 */
export function validateCancellation(
  status: PendingStatus,
): "ALREADY_DELIVERED" | "ALREADY_CANCELLED" | null {
  if (status === "ENTREGADO") return "ALREADY_DELIVERED";
  if (status === "CANCELADO") return "ALREADY_CANCELLED";
  return null;
}

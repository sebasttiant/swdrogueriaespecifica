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
  | "NOT_INVOICED"
  // Se separa de EXCEEDS_REMAINING a propósito: "no hay stock" manda al
  // operador a bodega, "excede lo pendiente" lo manda a revisar la cantidad.
  | "NO_INVENTORY";

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
  /**
   * Unidades REALMENTE reservadas y todavía sin consumir para este pendiente.
   *
   * Sale de la tabla de reservas, no de `Pending.reservedInventoryQuantity`:
   * esa columna nunca se decrementa al entregar, así que es un acumulado y
   * usarla como techo dejaría entregar dos veces la misma mercadería.
   */
  reservedQuantity: number;
  /** Lo que el cliente ya no espera. Sale del techo comercial. */
  cancelledQuantity?: number;
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
  // T2.2b: el cierre parcial es terminal — ya hubo entrega. Sin esta guarda,
  // `remainingQuantity` (que no conoce cancelledQuantity) permitiría entregar
  // sobre un pendiente que el cliente ya cerró en el mostrador.
  if (input.status === "CLOSED_PARTIAL") return "ALREADY_DELIVERED";
  // Facturar antes de entregar. `undefined` es una fila anterior a este eje: no
  // se le exige una factura que nunca se le pudo registrar.
  if (input.customerStatus !== undefined && input.customerStatus !== "FACTURADO") {
    return "NOT_INVOICED";
  }

  if (
    !Number.isInteger(input.deliverQuantity) ||
    input.deliverQuantity <= 0
  ) {
    return "NON_POSITIVE_QUANTITY";
  }

  // Sin mercadería reservada no hay nada que entregar, y decirlo aparte importa:
  // el mensaje "no hay stock" manda al operador a bodega, mientras que
  // "excede lo pendiente" lo manda a revisar la cantidad. Son dos problemas
  // distintos y llevan a dos lugares distintos.
  if (input.reservedQuantity <= 0) return "NO_INVENTORY";

  // El techo es el MENOR de tres, y el tercero es el que faltaba.
  //
  // Los dos primeros son compromisos comerciales —lo pedido y lo facturado— y
  // por sí solos permitieron registrar la salida de cinco unidades que nunca
  // entraron al inventario. El stock quedó mintiendo, y eso solo se descubre
  // cuando alguien va al estante y no encuentra nada.
  //
  // `cancelledQuantity` entra al techo comercial: lo que el cliente ya no
  // espera dejó de ser entregable.
  const remaining = Math.min(
    remainingQuantity(input.quantity, input.deliveredQuantity) -
      (input.cancelledQuantity ?? 0),
    (input.invoicedQuantity ?? input.quantity) - input.deliveredQuantity,
    input.reservedQuantity,
  );
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
  // T2.2b: el cierre parcial es terminal con entrega: cancelarlo
  // retroactivamente borraría la historia de lo que sí se entregó.
  if (status === "CLOSED_PARTIAL") return "ALREADY_DELIVERED";
  return null;
}

export type DeliverySummaryInput = {
  status: PendingStatus;
  quantity: number;
  deliveredQuantity: number;
  cancelledQuantity: number;
  unit: string;
};

/**
 * Línea de entrega de un pendiente para la UI (T4.2b·B).
 *
 * Explica la ecuación `delivered + cancelled = quantity`: un cierre parcial
 * (CLOSED_PARTIAL) cuenta lo entregado Y lo cancelado, porque el formato viejo
 * "Entregado: X / Y" dejaba muda la cantidad que el cliente ya no espera. Los
 * estados sin entrega (CANCELADO) no dicen que se entregó algo.
 */
export function deliverySummary(input: DeliverySummaryInput): string {
  if (input.status === "CANCELADO") return "Cancelado";
  if (input.status === "CLOSED_PARTIAL") {
    return `Entregado: ${input.deliveredQuantity} de ${input.quantity} · cancelado: ${input.cancelledQuantity} ${input.unit}`;
  }
  return `Entregado: ${input.deliveredQuantity} de ${input.quantity} ${input.unit}`;
}

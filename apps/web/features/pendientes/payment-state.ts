// --------------------------------------------------------------------------
// Estado de pago de un pendiente (seguimiento del cliente).
//
// El cliente puede dejar un abono al encargar el producto. Se guardan DOS
// números — `totalAmount` (valor acordado) y `paidAmount` (lo abonado) — y el
// estado se DERIVA de ellos. Nunca se persiste un booleano "pagado".
//
// ¿Por qué derivado? Porque un flag guardado puede contradecir a los montos:
// bastaría con marcar "pagado" y luego corregir el abono para que la fila
// mienta de forma permanente, sin manera de saber cuál de los dos datos vale.
// Un estado derivado no puede desincronizarse de los números que lo producen.
//
// Ambos montos son enteros de PESOS colombianos (sin centavos). Ver
// `lib/format/currency.ts`.
// --------------------------------------------------------------------------

export const PAYMENT_STATES = ["SIN_ABONO", "ABONADO", "PAGADO"] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

export type PendingPayment = {
  // Null cuando todavía no se acordó/conoce el valor (ej. producto manual que
  // hay que cotizar). No se infiere del abono: son datos distintos.
  totalAmount: number | null;
  paidAmount: number;
};

/**
 * Estado de pago derivado de los montos.
 *
 * - Sin abono: no entregó plata.
 * - Abonado: entregó parte, o entregó plata sin un total acordado todavía.
 * - Pagado: cubrió el total acordado.
 *
 * Sin total conocido nunca decimos "pagado", por más alto que sea el abono:
 * afirmar que está saldado sin saber contra qué sería inventar el dato.
 */
export function derivePaymentState({
  totalAmount,
  paidAmount,
}: PendingPayment): PaymentState {
  if (paidAmount <= 0) return "SIN_ABONO";
  if (totalAmount === null || totalAmount <= 0) return "ABONADO";
  return paidAmount >= totalAmount ? "PAGADO" : "ABONADO";
}

/**
 * Saldo que el cliente debe al retirar. Null cuando no hay total acordado (no
 * hay contra qué restar). Nunca negativo: un abono mayor al total es un vuelto
 * a favor del cliente, no una deuda negativa, y el saldo pendiente es cero.
 */
export function remainingAmount({
  totalAmount,
  paidAmount,
}: PendingPayment): number | null {
  if (totalAmount === null) return null;
  return Math.max(totalAmount - paidAmount, 0);
}

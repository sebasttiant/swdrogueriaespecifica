// --------------------------------------------------------------------------
// Medio de pago del abono (seguimiento del cliente).
//
// Cuando el cliente deja plata al encargar el producto, hace falta saber CÓMO
// la dejó: el efectivo entra a la caja y la transferencia hay que conciliarla
// contra el banco. Sin el medio, cuadrar la caja al cierre obliga a preguntarle
// al vendedor de memoria.
//
// Vocabulario CERRADO, y por eso es un enum de PostgreSQL y no texto canonizado
// como `zone`. La zona es abierta —mañana aparece un barrio nuevo—; los medios
// de pago no. Con un enum la base misma rechaza el valor inválido; con texto,
// "Trasnferencia" entra igual y el reporte por medio de pago devuelve dos filas
// para la misma cosa desde el primer mes.
//
// SIN MARCAS a propósito: no dice Nequi, ni Daviplata, ni Bancolombia. El dato
// que la operación necesita es el MÉTODO. La entidad cambia con cada convenio
// comercial y cada cambio obligaría a una migración del enum, mientras que
// "transferencia" va a significar lo mismo dentro de diez años.
//
// PURO: no toca Prisma ni el reloj. Lo usan los formularios, la lista y el
// esquema de validación.
// --------------------------------------------------------------------------

// El orden es el del mostrador: primero lo que más se usa. Es el orden en el
// que se pintan las opciones del desplegable, así que cambiarlo cambia la UI.
export const PAYMENT_METHODS = [
  "EFECTIVO",
  "TRANSFERENCIA",
  "TARJETA_DEBITO",
  "TARJETA_CREDITO",
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// El `Record` completo es lo que obliga a que agregar un medio al enum NO
// compile hasta escribirle su etiqueta. Un mapa parcial dejaría pasar el
// olvido y el cliente vería "TARJETA_CREDITO" en crudo.
const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  EFECTIVO: "Efectivo",
  TRANSFERENCIA: "Transferencia",
  TARJETA_DEBITO: "Tarjeta débito",
  TARJETA_CREDITO: "Tarjeta crédito",
};

/** Cómo se lee el medio en pantalla. */
export function paymentMethodLabel(method: PaymentMethod): string {
  return PAYMENT_METHOD_LABELS[method];
}

/**
 * ¿Es un medio del vocabulario?
 *
 * El valor llega de un `<select>` por FormData, o sea texto de la red: nada
 * garantiza que sea uno de los cuatro. Se compara contra el CÓDIGO, nunca
 * contra la etiqueta, para que cambiar una palabra en pantalla no cambie en
 * silencio lo que la base acepta.
 */
export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return (
    typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value)
  );
}

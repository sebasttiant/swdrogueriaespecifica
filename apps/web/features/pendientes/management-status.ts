
// --------------------------------------------------------------------------
// Reglas puras de los ESTADOS DE GESTIÓN de un pendiente (Mejora 2).
//
// Gerencia/compras fija uno de estos estados sobre un pendiente abierto para
// comunicarle al vendedor en qué punto está la búsqueda del producto:
//   SOLICITADO → ya se lo pedimos al proveedor; llega más tarde.
//   BUSQUEDA   → lo estamos buscando (sigue rebotando como faltante).
//   COTIZANDO  → esperando precio/negociación con el proveedor.
//   AGOTADO    → no se consigue. NO cancela el pendiente: es una señal para que
//                el vendedor avise al cliente y lo rechace por el flujo normal.
//
// PURO: no toca Prisma ni el reloj. El schema Zod y el service lo usan para
// validar; la UI lo usa para pintar el selector. Nunca importar Prisma acá.
// --------------------------------------------------------------------------

export const MANAGEMENT_STATUSES = [
  "SOLICITADO",
  "BUSQUEDA",
  "COTIZANDO",
  "AGOTADO",
] as const;

export type ManagementStatus = (typeof MANAGEMENT_STATUSES)[number];

// Etiquetas en español, fuente única para el selector de gerencia y cualquier
// leyenda. El badge de la lista mantiene su propio mapa porque además lleva
// tono de color; estas etiquetas deben coincidir con ese texto.
export const MANAGEMENT_STATUS_LABELS: Record<ManagementStatus, string> = {
  SOLICITADO: "Solicitado",
  BUSQUEDA: "En búsqueda",
  COTIZANDO: "Cotizando",
  AGOTADO: "Agotado",
};

export function isManagementStatus(value: unknown): value is ManagementStatus {
  return (
    typeof value === "string" &&
    (MANAGEMENT_STATUSES as readonly string[]).includes(value)
  );
}

// Estados desde los que gerencia puede fijar (o cambiar) un estado de gestión:
// un pendiente todavía abierto que NO entró al flujo de entrega. Un PARCIAL ya
// tiene una entrega en curso; un ENTREGADO/CANCELADO es terminal. En esos casos
// un cambio de gestión no tiene sentido y se rechaza.
export function canSetManagementStatus(status: unknown): boolean {
  return status === "POR_PEDIR" || status === "PENDIENTE" || isManagementStatus(status);
}

/** @deprecated Pending.status no longer owns purchase state. */
export const MANAGEMENT_ELIGIBLE_STATUSES = ["PENDIENTE", ...MANAGEMENT_STATUSES] as const;

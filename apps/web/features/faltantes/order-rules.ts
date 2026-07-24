import type { MissingItemStatus } from "@/lib/generated/prisma/client";

export function canTransitionToOrdered(currentStatus: MissingItemStatus): boolean {
  return currentStatus === "FALTANTE";
}

// Crear un proveedor al vuelo es un eje aparte del pedido: exige las dos
// capacidades. El servidor lo vuelve a chequear en la rama "proveedor nuevo".
export function canShowNewSupplierOrderForm(params: {
  canOrderMissingItems: boolean;
  canManageSuppliers: boolean;
}): boolean {
  return params.canOrderMissingItems && params.canManageSuppliers;
}

// Pedir a un proveedor EXISTENTE solo exige `canOrderMissingItems`: el servidor
// nunca pide `canManageSuppliers` en esa rama.
export function canOrderWithExistingSupplier(params: {
  canOrderMissingItems: boolean;
  hasSuppliers: boolean;
}): boolean {
  return params.canOrderMissingItems && params.hasSuppliers;
}

// El formulario se ofrece si alguna de las dos ramas es posible. Sin proveedores
// que elegir y sin permiso para crearlos no hay pedido posible: mostrarlo sería
// prometer una acción que el servidor va a rechazar.
export function canShowOrderForm(params: {
  canOrderMissingItems: boolean;
  canManageSuppliers: boolean;
  hasSuppliers: boolean;
}): boolean {
  return (
    canOrderWithExistingSupplier(params) || canShowNewSupplierOrderForm(params)
  );
}

// --------------------------------------------------------------------------
// Acciones masivas de gerencia sobre la cola de faltantes.
//
// El párrafo de gerencia ("debe haber una forma de eliminación rápida... darles
// a todos ok") esconde DOS situaciones opuestas, y por eso son DOS acciones y
// no un botón "OK":
//
//   1. Duplicado: dos vendedores anotaron el mismo producto. NADIE pidió nada.
//      Marcarlo como pedido dejaría en la base una orden a un proveedor que no
//      existe, y ese faltante entraría al conteo de mercadería por llegar.
//      → `CANCELADO` (descartar).
//
//   2. Ya se pidió: gerencia lo compró por fuera del sistema. Ahí sí hubo una
//      orden real, con un proveedor real.
//      → `PEDIDO` (marcar como pedido), que ya exige proveedor y cantidad.
//
// Un solo botón ambiguo para ambos casos es exactamente el error que se cometió
// con "OK gerencia" y que hubo que corregir después: aquellas filas nunca se
// cerraban solas al llegar el stock y nunca contaban como abiertas.
// --------------------------------------------------------------------------

/**
 * Un faltante se puede descartar mientras siga abierto y sin pedido. Un PEDIDO
 * ya comprometió una compra y un cerrado ya terminó su vida: descartarlos
 * borraría un hecho, no un duplicado.
 */
export function canDiscard(currentStatus: MissingItemStatus): boolean {
  return currentStatus === "FALTANTE";
}

/**
 * Reparte una selección entre lo que la acción admite y lo que no, sin lanzar.
 * La UI puede seleccionar filas mezcladas —es una lista, no un formulario— y
 * rechazar el lote entero por una fila obliga a repetir todo el trabajo. Se
 * aplica sobre las elegibles y se informa cuántas se saltearon.
 */
export function splitEligible<T>(
  items: readonly T[],
  isEligible: (item: T) => boolean,
): { eligible: T[]; skipped: T[] } {
  const eligible: T[] = [];
  const skipped: T[] = [];
  for (const item of items) {
    (isEligible(item) ? eligible : skipped).push(item);
  }
  return { eligible, skipped };
}

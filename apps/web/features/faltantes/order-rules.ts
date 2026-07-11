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

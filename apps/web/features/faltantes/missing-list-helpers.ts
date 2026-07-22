import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

export type OrderMetadata = {
  supplierName: string | null;
  orderedAt: Date | null;
  // Cantidad que gerencia pidió. Null en pedidos anteriores a la columna: se
  // muestra como "no registrada", nunca se sustituye por la necesidad.
  orderedQuantity: number | null;
};

// Detalle de la orden en curso: a qué proveedor se pidió y cuándo.
//
// Solo aplica a PEDIDO. Los estados cerrados (RECIBIDO, CANCELADO) conservan
// `supplier`/`orderedAt` en la fila, pero mostrarlos ahí haría leer como "orden
// en curso" algo que ya se cerró. Devuelve null cuando no hay nada que mostrar,
// para que el render no tenga que decidirlo.
export function getOrderMetadata(item: MissingItemListItem): OrderMetadata | null {
  if (item.status !== "PEDIDO") return null;
  if (!item.supplier && !item.orderedAt) return null;

  return {
    supplierName: item.supplier?.name ?? null,
    orderedAt: item.orderedAt,
    orderedQuantity: item.orderedQuantity,
  };
}

// Etiqueta de la cantidad pedida. Un pedido anterior a la columna no tiene el
// dato: se dice explícitamente, en vez de mostrar la necesidad como si fuera
// lo pedido.
export function orderedQuantityLabel(orderedQuantity: number | null): string {
  return orderedQuantity === null
    ? "Cantidad pedida no registrada"
    : `Cantidad pedida: ${orderedQuantity} unidades`;
}

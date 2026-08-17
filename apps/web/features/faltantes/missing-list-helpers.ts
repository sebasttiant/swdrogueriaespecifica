import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

export type OrderMetadata = {
  supplierName: string | null;
  orderedAt: Date | null;
  // Cantidad ESPERADA. Null en pedidos anteriores al backfill: se dice "no
  // registrada", nunca se sustituye en silencio por otro número.
  orderedQuantity: number | null;
  // Cantidad REAL recibida hasta ahora, cargada por bodega.
  receivedQuantity: number;
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
    receivedQuantity: item.receivedQuantity,
  };
}

/**
 * Cantidades de un pedido, en el idioma de la droguería.
 *
 * Dice "Faltaban N · llegaron M" y NUNCA "pediste N" (D10). El gerente no
 * declara una cantidad: toca un chulito y el sistema deriva lo que faltaba.
 * Escribir "pediste 40" le atribuiría una decisión que no tomó, y es la clase
 * de frase que después se discute en una reunión.
 *
 * Un pedido anterior al backfill no tiene cantidad esperada: se dice, en vez
 * de sustituirla en silencio por otro número.
 */
export function orderedQuantityLabel(
  orderedQuantity: number | null,
  receivedQuantity = 0,
): string {
  if (orderedQuantity === null) {
    return receivedQuantity > 0
      ? `Cantidad esperada no registrada · llegaron ${receivedQuantity}`
      : "Cantidad esperada no registrada";
  }
  return `Faltaban ${orderedQuantity} · llegaron ${receivedQuantity}`;
}

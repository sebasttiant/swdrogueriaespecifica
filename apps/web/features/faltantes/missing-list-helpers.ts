import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

export type PageOverview = {
  total: number;
  open: number;
  confirmed: number;
};

export type ConfirmationMetadata = {
  label: "Pendiente" | "Confirmado";
  confirmedAt: Date | null;
};

export type OrderMetadata = {
  supplierName: string | null;
  orderedAt: Date | null;
};

export function getPageOverview(items: readonly MissingItemListItem[]): PageOverview {
  return items.reduce<PageOverview>(
    (overview, item) => {
      const isConfirmed = Boolean(item.confirmedAt);
      const isOpenStatus = item.status === "FALTANTE" || item.status === "PEDIDO";

      return {
        total: overview.total + 1,
        open: isOpenStatus && !isConfirmed ? overview.open + 1 : overview.open,
        confirmed: isConfirmed ? overview.confirmed + 1 : overview.confirmed,
      };
    },
    { total: 0, open: 0, confirmed: 0 },
  );
}

export function getConfirmationMetadata(
  item: MissingItemListItem,
): ConfirmationMetadata {
  if (!item.confirmedAt) {
    return { label: "Pendiente", confirmedAt: null };
  }

  return { label: "Confirmado", confirmedAt: item.confirmedAt };
}

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
  };
}

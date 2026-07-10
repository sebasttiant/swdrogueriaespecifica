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

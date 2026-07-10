import type { MissingItemStatus } from "@/lib/generated/prisma/client";

export function canTransitionToOrdered(currentStatus: MissingItemStatus): boolean {
  return currentStatus === "FALTANTE";
}

export function canShowNewSupplierOrderForm(params: {
  canOrderMissingItems: boolean;
  canManageSuppliers: boolean;
}): boolean {
  return params.canOrderMissingItems && params.canManageSuppliers;
}

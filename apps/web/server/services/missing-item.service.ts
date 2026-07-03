// --------------------------------------------------------------------------
// Servicio de faltantes (server-only). Boundary de lectura: la página delega
// acá y nunca toca el repositorio directo. La creación automática de faltantes
// vive en `pending.service` porque es un efecto del caso de uso "registrar
// pendiente" (ver computeMissingQuantity).
// --------------------------------------------------------------------------

import type { Paginated } from "@/lib/pagination";
import {
  confirmMissingItem,
  countOpenMissingItems,
  findMissingItemById,
  listMissingItems,
  type MissingItemListItem,
} from "@/server/repositories/missing-item.repository";
import type { MissingItemStatus } from "@/lib/generated/prisma/client";

export type ConfirmMissingItemInput = {
  id: string;
  confirmedById: string;
  confirmedAt?: Date;
  note?: string;
};

export type ConfirmMissingItemResult = {
  item: {
    id: string;
    status: MissingItemStatus;
    confirmedAt: Date | null;
    confirmedById: string | null;
    confirmationNote: string | null;
  };
  changed: boolean;
};

const CONFIRMABLE_STATUSES: MissingItemStatus[] = ["FALTANTE", "PEDIDO"];

export function getMissingItems(params: {
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<MissingItemListItem>> {
  return listMissingItems(params);
}

// Conteo de faltantes abiertos para el KPI del dashboard.
export function getOpenMissingCount(): Promise<number> {
  return countOpenMissingItems();
}

export async function confirmMissingItemOk(
  input: ConfirmMissingItemInput,
): Promise<ConfirmMissingItemResult> {
  const current = await findMissingItemById(input.id);
  if (!current) throw new Error("Missing item not found");

  if (
    current.confirmedAt !== null ||
    !CONFIRMABLE_STATUSES.includes(current.status)
  ) {
    return { item: current, changed: false };
  }

  const item = await confirmMissingItem(input);
  return { item, changed: true };
}

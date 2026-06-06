// --------------------------------------------------------------------------
// Servicio de faltantes (server-only). Boundary de lectura: la página delega
// acá y nunca toca el repositorio directo. La creación automática de faltantes
// vive en `pending.service` porque es un efecto del caso de uso "registrar
// pendiente" (ver computeMissingQuantity).
// --------------------------------------------------------------------------

import type { Paginated } from "@/lib/pagination";
import {
  listMissingItems,
  type MissingItemListItem,
} from "@/server/repositories/missing-item.repository";

export function getMissingItems(params: {
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<MissingItemListItem>> {
  return listMissingItems(params);
}

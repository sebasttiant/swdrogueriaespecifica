// --------------------------------------------------------------------------
// Servicio de productos (server-only). Boundary de negocio: la página/acción
// delega acá y nunca toca el repositorio directo. Hoy es fino; crece con las
// reglas (el alta llega en el Grupo B de este slice).
// --------------------------------------------------------------------------

import type { Paginated } from "@/lib/pagination";
import {
  listProducts,
  type ProductListItem,
} from "@/server/repositories/product.repository";

export function getProducts(params: {
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<ProductListItem>> {
  return listProducts(params);
}

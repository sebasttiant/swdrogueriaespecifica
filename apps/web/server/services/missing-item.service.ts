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
  countOverdueMissingItems,
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

export async function getMissingItems(params: {
  cursor?: string | null;
  take?: number;
  // Requerido (sin default): que falte el flag debe ser un error de tipos,
  // nunca una fuga silenciosa de PII. `false` fuerza la minimización abajo.
  canViewCustomerIdentity: boolean;
}): Promise<Paginated<MissingItemListItem>> {
  const { canViewCustomerIdentity, ...listParams } = params;
  const { items, nextCursor } = await listMissingItems(listParams);

  // Minimización server-side: el nombre del cliente nunca llega al cliente
  // (ni siquiera serializado en el HTML) para roles sin esta capability.
  // Nunca mutamos las filas del repositorio; devolvemos objetos nuevos.
  const minimizedItems = canViewCustomerIdentity
    ? items
    : items.map((item) => ({
        ...item,
        origin: item.origin ? { ...item.origin, customerName: null } : null,
      }));

  return { items: minimizedItems, nextCursor };
}

// Conteo de faltantes abiertos para el KPI del dashboard.
export function getOpenMissingCount(): Promise<number> {
  return countOpenMissingItems();
}

export type MissingItemsSummary = {
  open: number;
  overdue: number;
};

// Métricas GLOBALES (no derivadas de la página actual, que está paginada por
// cursor). `overdue` es un SUBCONJUNTO de `open` (además exige confirmedAt:
// null + status abierto + promesa vencida) — la UI debe dejarlo claro.
// `now` inyectable para tests deterministas.
export async function getMissingItemsSummary(
  now: Date = new Date(),
): Promise<MissingItemsSummary> {
  const [open, overdue] = await Promise.all([
    countOpenMissingItems(),
    countOverdueMissingItems(now),
  ]);
  return { open, overdue };
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

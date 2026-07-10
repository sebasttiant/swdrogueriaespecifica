// --------------------------------------------------------------------------
// Agrupación pura de faltantes por urgencia, dentro de la página actual (el
// listado es cursor-paginado; esto NO agrupa el total global).
// Función pura, `now` inyectable, sin dependencias de Prisma más allá de los
// tipos ya expuestos por el repositorio.
// --------------------------------------------------------------------------

import { computeDeadlineStatus } from "../pendientes/deadline-status";
import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

const URGENCY_ORDER = {
  VENCIDO: 0,
  VENCE_PRONTO: 1,
  EN_CURSO: 2,
} as const;

export type MissingGroupKey = keyof typeof URGENCY_ORDER;

export type MissingGroup = {
  key: MissingGroupKey;
  items: MissingItemListItem[];
};

function missingGroupKey(item: MissingItemListItem, now: Date): MissingGroupKey {
  if (!item.origin) return "EN_CURSO";

  const deadline = computeDeadlineStatus(item.origin.promisedAt, item.origin.status, now);
  if (deadline === "VENCIDO") return "VENCIDO";
  if (deadline === "VENCE_PRONTO") return "VENCE_PRONTO";
  return "EN_CURSO"; // A_TIEMPO | FINALIZADO
}

export function groupMissingItems(
  items: readonly MissingItemListItem[],
  now: Date = new Date(),
): MissingGroup[] {
  const buckets = new Map<MissingGroupKey, MissingItemListItem[]>();

  for (const item of items) {
    const key = missingGroupKey(item, now);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(key, [item]);
    }
  }

  return Array.from(buckets.entries())
    .map(([key, groupItems]) => ({ key, items: groupItems }))
    .sort((left, right) => URGENCY_ORDER[left.key] - URGENCY_ORDER[right.key]);
}

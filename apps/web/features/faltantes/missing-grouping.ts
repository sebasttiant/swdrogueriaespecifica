// --------------------------------------------------------------------------
// Agrupación pura de faltantes por urgencia operativa, dentro de la página
// actual (el listado es cursor-paginado; esto NO agrupa el total global).
// Función pura, `now` inyectable, sin dependencias de Prisma más allá de los
// tipos ya expuestos por el repositorio.
// --------------------------------------------------------------------------

import { computeDeadlineStatus } from "../pendientes/deadline-status";
import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

export type MissingGroupKey = "VENCIDO" | "VENCE_PRONTO" | "EN_CURSO";

export type MissingGroup = {
  key: MissingGroupKey;
  items: MissingItemListItem[];
};

// Orden fijo de prioridad operativa: lo vencido primero, lo que ya no
// requiere vigilancia (EN_CURSO) al final.
const GROUP_ORDER: readonly MissingGroupKey[] = [
  "VENCIDO",
  "VENCE_PRONTO",
  "EN_CURSO",
];

// Extractor de la clave de agrupación. Este es el ÚNICO punto que una futura
// agrupación por proveedor/laboratorio necesitaría reemplazar: el resto del
// pipeline (`groupMissingItems`) no depende de cómo se deriva la clave.
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
  const buckets: Record<MissingGroupKey, MissingItemListItem[]> = {
    VENCIDO: [],
    VENCE_PRONTO: [],
    EN_CURSO: [],
  };

  for (const item of items) {
    buckets[missingGroupKey(item, now)].push(item);
  }

  return GROUP_ORDER.filter((key) => buckets[key].length > 0).map((key) => ({
    key,
    items: buckets[key],
  }));
}

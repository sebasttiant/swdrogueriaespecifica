// --------------------------------------------------------------------------
// Quién tocó el faltante y cuándo.
//
// Respaldo del gerente (reunión 2026-07-30, min 2:52): "Espérate, ¿quién colocó
// esto? ... a ver, ¿quién colocó esto? Ah, okay. Eso lo colocó Andrés". La cola
// la trabajan DOS personas a la vez y hasta ahora no se distinguía quién había
// marcado qué, así que había que preguntarlo por teléfono.
//
// Es trazabilidad de staff, no PII de cliente: mismo criterio de visibilidad
// que `confirmedBy` en el repositorio. Solo el nombre, nunca email ni rol.
// --------------------------------------------------------------------------

import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

// Cuando el responsable no se puede resolver —registros del flujo viejo, o un
// usuario que ya no existe— se dice explícitamente. Inventar un nombre, o caer
// al usuario que está mirando la pantalla, sería peor que no mostrar nada.
export const UNKNOWN_ACTOR = "Sin registrar";

export type MissingAttribution = {
  /** "Pedido por" / "Descartado por": el verbo del hecho, no del estado. */
  label: string;
  name: string;
  at: Date | null;
};

type AttributableItem = Pick<
  MissingItemListItem,
  | "status"
  | "orderedAt"
  | "orderedBy"
  | "discardedAt"
  | "discardedBy"
  | "confirmedAt"
  | "confirmedBy"
>;

/**
 * Atribución que corresponde mostrar, o `null` si el faltante todavía no fue
 * tocado por nadie (sigue en la cola de trabajo).
 *
 * Precedencia: el hecho más reciente y más específico gana. Un faltante
 * CANCELADO muestra quién lo descartó; uno PEDIDO, quién lo pidió. Los pedidos
 * históricos (`confirmedAt` del flujo viejo "OK gerencia") se muestran como
 * pedidos, porque eso es lo que fueron: una compra real.
 */
export function missingAttribution(
  item: AttributableItem,
): MissingAttribution | null {
  if (item.status === "CANCELADO") {
    return {
      label: "Descartado por",
      name: item.discardedBy?.name ?? UNKNOWN_ACTOR,
      at: item.discardedAt,
    };
  }

  if (item.orderedAt !== null || item.status === "PEDIDO") {
    return {
      label: "Pedido por",
      name: item.orderedBy?.name ?? UNKNOWN_ACTOR,
      at: item.orderedAt,
    };
  }

  // Pedido histórico: quedó en FALTANTE con `confirmedAt` porque el flujo viejo
  // no escribía el status. Fue una compra real, así que se lee como pedido.
  if (item.confirmedAt !== null) {
    return {
      label: "Pedido por",
      name: item.confirmedBy?.name ?? UNKNOWN_ACTOR,
      at: item.confirmedAt,
    };
  }

  return null;
}

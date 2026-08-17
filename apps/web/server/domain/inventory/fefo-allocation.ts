// --------------------------------------------------------------------------
// Reparto FEFO de una cantidad entre varios lotes (P2 · T2.1).
//
// Entre "qué lotes se pueden usar" (T1.2) y "cómo se mueve UN lote" (T1.4)
// faltaba esto: repartir 30 unidades entre tres lotes. Un pedido rara vez entra
// en un solo lote, y quién paga el sobrante no puede quedar librado al azar.
//
// PURO: no toca Prisma ni el reloj. Recibe los lotes ya elegidos y ordenados, y
// devuelve el reparto. Todo lo que decide se puede probar sin base de datos, y
// lo que queda para PostgreSQL es solo lo que solo ahí se puede probar.
//
// EL ORDEN LO TRAE EL LLAMADOR, y no es un detalle: `listEligibleLots` (T1.2)
// ya define FEFO con su desempate reproducible —vencimiento con los nulos al
// final, después recepción, después id— y además excluye vencidos y en
// cuarentena. Reordenar acá crearía una SEGUNDA definición de FEFO que puede
// separarse de la primera sin que nada falle. Este módulo respeta el orden que
// recibe; de dónde sale es responsabilidad del repositorio.
// --------------------------------------------------------------------------

export type AllocatableLot = {
  id: string;
  /** Lo que se puede comprometer: `onHand - activeReserved`, ya derivado. */
  available: number;
};

export type AllocationLine = {
  lotId: string;
  quantity: number;
};

export type AllocationPlan = {
  /** Una línea por lote que aporta. Los lotes que no aportan no aparecen. */
  lines: AllocationLine[];
  allocated: number;
  /** Lo que no se pudo cubrir. Cero cuando el plan alcanza. */
  shortfall: number;
};

/**
 * Reparte `quantity` entre los lotes, en el orden en que vienen.
 *
 * El déficit se INFORMA en vez de lanzarse: quien pide decide si una entrega
 * parcial le sirve, y en una droguería muchas veces sirve —el cliente se lleva
 * lo que hay y espera el resto. Lanzar acá le sacaría esa decisión.
 */
export function planFefoAllocation(
  lots: readonly AllocatableLot[],
  quantity: number,
): AllocationPlan {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError(`quantity must be a positive integer, received ${quantity}`);
  }

  const lines: AllocationLine[] = [];
  let remaining = quantity;

  for (const lot of lots) {
    if (remaining === 0) break;
    // Disponible en cero no aporta; en negativo el lote ya está
    // sobre-comprometido y sacarle unidades agrandaría el agujero.
    if (lot.available <= 0) continue;

    const taken = Math.min(remaining, lot.available);
    lines.push({ lotId: lot.id, quantity: taken });
    remaining -= taken;
  }

  return { lines, allocated: quantity - remaining, shortfall: remaining };
}

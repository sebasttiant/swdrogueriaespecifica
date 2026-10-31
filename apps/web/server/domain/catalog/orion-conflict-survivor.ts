// --------------------------------------------------------------------------
// Quién sobrevive cuando varias filas comparten el mismo número de Orión.
//
// Es puro a propósito: el servicio de merge lo usa y los tests lo fijan sin
// base. La regla existe para que 160 grupos no se resuelvan a mano uno por uno
// cuando la evidencia es mecánica —y para que lo que NO es mecánico (dos
// copias con stock) quede bloqueado, no fusionado a ciegas.
//
// Orden:
//   1. Si más de una fila tiene stock > 0 → BLOQUEADO (hay que consolidar
//      inventario antes; el merge no mueve lotes).
//   2. Si exactamente una tiene stock → esa sobrevive (conserva los lotes).
//   3. Si ninguna tiene stock → prefiere la que ya está en forma canónica
//      `A{núcleo}`; si nadie, la más vieja (createdAt, luego id).
// --------------------------------------------------------------------------

export type OrionConflictCandidate = {
  id: string;
  orionCode: string;
  /** Cantidad en lotes legados + canónicos; 0 si no hay. */
  stock: number;
  createdAt: Date;
};

export type SurvivorDecision =
  | { status: "pick"; survivorId: string }
  | { status: "blocked"; reason: string };

/**
 * Elige el sobreviviente de un grupo que ya comparte el mismo núcleo numérico.
 */
export function pickOrionConflictSurvivor(
  canonicalCode: string,
  candidates: OrionConflictCandidate[],
): SurvivorDecision {
  if (candidates.length < 2) {
    return {
      status: "blocked",
      reason: "Un grupo de conflicto necesita al menos dos productos.",
    };
  }

  const withStock = candidates.filter((row) => row.stock > 0);
  if (withStock.length > 1) {
    const ids = withStock.map((row) => `${row.id}(${row.stock})`).join(", ");
    return {
      status: "blocked",
      reason: `Más de una copia tiene stock: ${ids}. Consolidá inventario antes del merge.`,
    };
  }
  if (withStock.length === 1) {
    return { status: "pick", survivorId: withStock[0]!.id };
  }

  const alreadyCanonical = candidates.find((row) => row.orionCode === canonicalCode);
  if (alreadyCanonical) {
    return { status: "pick", survivorId: alreadyCanonical.id };
  }

  const oldest = [...candidates].sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  })[0];
  return { status: "pick", survivorId: oldest!.id };
}

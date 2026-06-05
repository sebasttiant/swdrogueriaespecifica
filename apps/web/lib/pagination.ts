// --------------------------------------------------------------------------
// Paginación cursor-based — fundación compartida.
//
// Regla del proyecto: NINGÚN repository expone un listado sin `take`. El cursor
// es opaco (base64 del id del último item). Escala plano a tablas grandes sin
// el costo del offset profundo. Offset/limit solo si una pantalla pide páginas
// numeradas explícitas.
// --------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export type Paginated<T> = {
  items: T[];
  nextCursor: string | null;
};

export function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string | null {
  if (!cursor) return null;
  try {
    const id = Buffer.from(cursor, "base64url").toString("utf8");
    // El decoder de Node es tolerante con basura: validamos exigiendo que el
    // cursor sea exactamente uno que nosotros emitimos (round-trip).
    if (id.length === 0 || encodeCursor(id) !== cursor) return null;
    return id;
  } catch {
    return null;
  }
}

/** Acota `take` al rango [1, MAX]; usa el default si viene vacío. */
export function clampTake(take: number | undefined): number {
  if (take === undefined || Number.isNaN(take)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(take)));
}

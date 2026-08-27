// --------------------------------------------------------------------------
// Identidad de laboratorio — reglas PURAS, sin base de datos.
//
// Un laboratorio se identifica por su nombre normalizado (minúsculas, sin
// espacios extras). El nombre ES la identidad: no hay código Orion ni SKU
// interno para laboratorios.
//
// Todo lo que decide identidad vive acá y no toca Prisma, para poder probar
// las reglas sin base — el mismo patrón de `domain/catalog/sku-identity.ts`.
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Errores tipados. La Server Action los mapea a un mensaje para el operador.
// --------------------------------------------------------------------------

export type LaboratoryIdentityCode =
  /** El nombre viene vacío o solo espacios. */
  | "MISSING_NAME"
  /** Ya existe un laboratorio con ese nombre exacto (misma clave normalizada). */
  | "EXACT_NAME_EXISTS"
  /** El rol no puede crear laboratorios. */
  | "FORBIDDEN_ACTOR"
  /** No se encontró el laboratorio solicitado. */
  | "UNKNOWN_LABORATORY";

export class LaboratoryIdentityError extends Error {
  constructor(public readonly code: LaboratoryIdentityCode) {
    super(code);
    this.name = "LaboratoryIdentityError";
  }
}

// --------------------------------------------------------------------------
// Normalización — la clave canónica del laboratorio.
//
// El nombre normalizado es la IDENTIDAD: misma clave = mismo laboratorio.
// Minúsculas + trim + colapsar espacios múltiples. Sin tildes, sin puntuación:
// "Bayer S.A." y "bayer s.a" son el mismo laboratorio; "Bayer" y "Bayer Chile"
// son distintos.
// --------------------------------------------------------------------------

const MULTI_SPACE = /\s+/g;

/** Normaliza un nombre de laboratorio a su clave canónica. */
export function normalizeLaboratoryName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(MULTI_SPACE, " ");
}

// --------------------------------------------------------------------------
// Validación de entrada.
// --------------------------------------------------------------------------

export function assertValidLaboratoryName(name: string): void {
  const normalized = normalizeLaboratoryName(name);
  if (normalized.length === 0) {
    throw new LaboratoryIdentityError("MISSING_NAME");
  }
}

// --------------------------------------------------------------------------
// Resultado de la búsqueda — los 8 candidatos, con prefijos primero.
// --------------------------------------------------------------------------

export type LaboratoryCandidate = {
  id: string;
  name: string;
  searchKey: string | null;
  needsReview: boolean;
};

/**
 * Filtra y ordena candidatos: prefijos exactos primero, luego contains.
 * Solo incluye candidatos cuyo searchKey contiene la query.
 * Devuelve máximo `limit` resultados (default 8).
 */
export function rankLaboratoryCandidates(
  candidates: LaboratoryCandidate[],
  query: string,
  limit = 8,
): LaboratoryCandidate[] {
  const normalizedQuery = normalizeLaboratoryName(query);
  if (normalizedQuery.length === 0) return candidates.slice(0, limit);

  const scored = candidates
    .filter((c) => {
      const key = c.searchKey ?? normalizeLaboratoryName(c.name);
      return key.includes(normalizedQuery);
    })
    .map((c) => {
      const key = c.searchKey ?? normalizeLaboratoryName(c.name);
      const isPrefix = key.startsWith(normalizedQuery);
      return { candidate: c, isPrefix };
    });

  // Prefijos primero, luego el resto (manteniendo orden original)
  const prefixFirst = scored.sort((a, b) => {
    if (a.isPrefix && !b.isPrefix) return -1;
    if (!a.isPrefix && b.isPrefix) return 1;
    return 0;
  });

  return prefixFirst.slice(0, limit).map((s) => s.candidate);
}

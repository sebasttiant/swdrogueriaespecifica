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
// Normalización — AYUDA de la pantalla, NO la identidad.
//
// Minúsculas + trim + colapsar espacios múltiples: "Bayer S.A." y "bayer s.a."
// son el mismo laboratorio; "Bayer" y "Bayer Chile" son distintos.
//
// Ojo con lo que esta función NO es: la identidad de un laboratorio la calcula
// la BASE, con `laboratory_canonical_identity(text)`, y es la única autoridad.
// Ver `20260828120000_add_laboratory_canonical_identity`.
//
// El intento de sostener las dos implementaciones en paralelo falló porque el
// plegado de mayúsculas de Unicode no coincide y no puede coincidir:
//
//   "ΟΣ"          acá -> 03bf 03c2 (sigma FINAL)   PostgreSQL -> 03bf 03c3
//   "İ"           acá -> 0069 0307 (largo 2)       PostgreSQL -> 0069
//   "AB"    acá conserva U+0085              PostgreSQL lo hace espacio
//
// Las reglas de PostgreSQL dependen de su versión de Unicode y de su ICU: no
// son reproducibles desde acá. Por eso esta función quedó para normalizar lo
// que se TIPEA —decidir si la consulta está vacía, armar el patrón del ILIKE—,
// donde una diferencia solo cambia qué se encuentra y nunca puede crear un
// laboratorio duplicado.
//
// No la uses para decidir si dos nombres son el mismo laboratorio.
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
// Clave de idempotencia de la CREACIÓN.
//
// Identifica un comando: "esta persona, por esta vía, quiso crear ESTE
// laboratorio". Por eso incluye el nombre normalizado y no solo el usuario.
//
// Sin el nombre la clave era constante por persona, y como `createCommandKey`
// tiene índice único, el SEGUNDO laboratorio que alguien creaba chocaba contra
// el de su propio laboratorio anterior. La clave decía "un comando por usuario"
// cuando lo que se quería decir era "un comando por usuario y laboratorio".
//
// La recepción de mercadería NO usa esta función: su clave sale de la
// `idempotencyKey` de la entrada, que ya identifica un intento concreto.
// --------------------------------------------------------------------------
export type LaboratoryCreateSource = "auto" | "manual";

export function laboratoryCreateCommandKey(
  source: LaboratoryCreateSource,
  userId: string,
  name: string,
): string {
  return `${source}:${userId}:${normalizeLaboratoryName(name)}`;
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

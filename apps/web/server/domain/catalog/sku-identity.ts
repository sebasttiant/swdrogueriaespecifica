// --------------------------------------------------------------------------
// Identidad de producto — reglas PURAS, sin base de datos.
//
// Un producto se identifica de forma EXACTA por una de tres claves: su id,
// su SKU interno o su código Orion. El nombre NUNCA identifica: dos productos
// distintos se llaman parecido, y adivinar por nombre termina mezclando el
// inventario de uno con el del otro.
//
// El código Orion es la identidad canónica e inmutable. El SKU interno lo
// genera el servidor (`PRV-{ULID}`) cuando un producto entra al catálogo sin
// código Orion todavía; queda marcado para revisión.
//
// Todo lo que decide identidad vive acá y no toca Prisma, para poder probar
// las reglas sin base — el mismo patrón de `lib/auth/permissions.ts`.
// --------------------------------------------------------------------------

import type { SessionRole } from "@/lib/auth/session";

// --------------------------------------------------------------------------
// Errores tipados. La Server Action los mapea a un mensaje para el operador.
// --------------------------------------------------------------------------

export type SkuIdentityCode =
  /** Vinieron dos identidades exactas a la vez y no se puede elegir por él. */
  | "AMBIGUOUS_MODE"
  /** El rol no puede acuñar identidad de producto. */
  | "FORBIDDEN_ACTOR"
  /** No vino ninguna identidad exacta (un nombre no cuenta). */
  | "MISSING_EXACT_IDENTITY"
  /** La identidad exacta no corresponde a ningún producto. */
  | "UNKNOWN_SKU"
  /** El id y el SKU recibidos apuntan a productos distintos. */
  | "ID_SKU_MISMATCH"
  /** El código Orion ya está tomado, o el producto ya tiene otro. */
  | "ORION_CONFLICT"
  /** Se agotó el presupuesto de reintentos por colisión. */
  | "GENERATION_EXHAUSTED";

export class SkuIdentityError extends Error {
  constructor(public readonly code: SkuIdentityCode) {
    super(code);
    this.name = "SkuIdentityError";
  }
}

// --------------------------------------------------------------------------
// Quién puede acuñar identidad.
//
// BODEGA entra porque recibe mercadería que todavía no está en el catálogo y
// necesita darla de alta para poder registrarla. Supervisión y vendedores NO:
// ven el catálogo, pero crear identidad canónica es otra cosa.
// --------------------------------------------------------------------------

export const SKU_ONBOARDING_ROLES: readonly SessionRole[] = [
  "SUPERADMIN",
  "ADMIN",
  "BODEGA",
];

/**
 * Quién CORRIGE una identidad ya cargada.
 *
 * El conjunto es más ancho que el de acuñación, y a propósito: acuñar crea
 * identidad nueva, corregir repara una que ya está mal. Supervisión entra
 * porque es quien recibe el reclamo del vendedor cuando el código quedó
 * cambiado. El vendedor NO: su única corrección va por su propio pendiente,
 * con el límite de una sola vez que ya rige ahí.
 */
export const SKU_FIX_ROLES: readonly SessionRole[] = [
  "SUPERADMIN",
  "ADMIN",
  "SUPERVISOR",
  "BODEGA",
];

export function canFixSkuIdentity(role: SessionRole): boolean {
  return SKU_FIX_ROLES.includes(role);
}

export function assertCanFixSkuIdentity(role: SessionRole): void {
  if (!canFixSkuIdentity(role)) throw new SkuIdentityError("FORBIDDEN_ACTOR");
}

/**
 * Quién VINCULA mientras captura: los cinco roles, porque los cinco capturan y
 * el que tiene el cliente enfrente es el que está leyendo Orion.
 *
 * Es LINK y nada más. Acuñar desde el catálogo, mudar un código y corregir uno
 * puesto siguen en sus propias autoridades; la captura no recibe ninguna.
 */
export const SKU_CAPTURE_LINK_ROLES: readonly SessionRole[] = [
  "SUPERADMIN",
  "ADMIN",
  "SUPERVISOR",
  "OPERADOR",
  "BODEGA",
];

export function canLinkAtCapture(role: SessionRole): boolean {
  return SKU_CAPTURE_LINK_ROLES.includes(role);
}

export function assertCanLinkAtCapture(role: SessionRole): void {
  if (!canLinkAtCapture(role)) throw new SkuIdentityError("FORBIDDEN_ACTOR");
}

export function canOnboardSku(role: SessionRole): boolean {
  return SKU_ONBOARDING_ROLES.includes(role);
}

export function assertCanOnboardSku(role: SessionRole): void {
  if (!canOnboardSku(role)) throw new SkuIdentityError("FORBIDDEN_ACTOR");
}

// --------------------------------------------------------------------------
// SKU interno provisional: `PRV-{ULID}`.
//
// El ULID lleva el instante de creación adelante, así los SKU provisionales
// ordenan por antigüedad sin consultar la base, y 80 bits de azar atrás, que
// es lo que hace improbable la colisión.
// --------------------------------------------------------------------------

export const PROVISIONAL_SKU_PREFIX = "PRV-";

/** Presupuesto D2 aprobado: cinco intentos y después error terminal. */
export const SKU_COLLISION_MAX_ATTEMPTS = 5;

// Alfabeto Crockford base32: sin I, L, O ni U, para que nadie confunda un
// carácter al dictarlo o transcribirlo.
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_TIME_LENGTH = 10;
const ULID_RANDOM_BYTES = 10;

export function generateUlid(epochMs: number, randomness: Uint8Array): string {
  if (randomness.length !== ULID_RANDOM_BYTES) {
    throw new Error(`El ULID necesita exactamente ${ULID_RANDOM_BYTES} bytes de azar.`);
  }

  let time = "";
  let remaining = Math.floor(epochMs);
  for (let position = 0; position < ULID_TIME_LENGTH; position += 1) {
    time = CROCKFORD_ALPHABET[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }

  // Los 10 bytes (80 bits) se leen de a 5 bits para dar 16 caracteres.
  let bits = 0;
  let bitCount = 0;
  let random = "";
  for (const byte of randomness) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      random += CROCKFORD_ALPHABET[(bits >> bitCount) & 31];
    }
  }

  return time + random;
}

export function provisionalSkuFor(ulid: string): string {
  return `${PROVISIONAL_SKU_PREFIX}${ulid}`;
}

const PROVISIONAL_SKU_PATTERN = new RegExp(
  `^${PROVISIONAL_SKU_PREFIX}[${CROCKFORD_ALPHABET}]{26}$`,
);

export function isProvisionalSku(value: string): boolean {
  return PROVISIONAL_SKU_PATTERN.test(value);
}

export function assertAttemptWithinBudget(attempt: number): void {
  if (attempt > SKU_COLLISION_MAX_ATTEMPTS) {
    throw new SkuIdentityError("GENERATION_EXHAUSTED");
  }
}

// --------------------------------------------------------------------------
// Identidad exacta.
// --------------------------------------------------------------------------

/**
 * Tope de longitud, en CARACTERES Unicode y no en unidades UTF-16.
 *
 * `"𝔸".length` es 2 —un par suplente ocupa dos unidades—, así que medir con
 * `.length` rechazaría 80 caracteres astrales por creerlos 160. La columna es
 * `TEXT` en PostgreSQL, que cuenta con `char_length`, o sea caracteres: medir
 * distinto que la base sería rechazar códigos que la base acepta.
 */
export const ORION_CODE_MAX_CHARS = 80;
const INTERNAL_ORION_CODE_WHITESPACE = /[\p{White_Space}\uFEFF]/u;

/** Recorta los extremos y valida; NO cambia mayúsculas: la identidad es exacta. */
export function normalizeOrionCode(raw: string): string {
  const code = raw.trim();

  if (
    code === "" ||
    INTERNAL_ORION_CODE_WHITESPACE.test(code) ||
    [...code].length > ORION_CODE_MAX_CHARS
  ) {
    throw new SkuIdentityError("MISSING_EXACT_IDENTITY");
  }

  return code;
}

export type IdentityInput = {
  productId?: string | null;
  internalSku?: string | null;
  orionCode?: string | null;
  /** Se acepta para mostrarlo, jamás para identificar. */
  name?: string | null;
};

export type IdentityMode = {
  mode: "PRODUCT_ID" | "INTERNAL_SKU" | "ORION_CODE";
  value: string;
};

export function resolveIdentityMode(input: IdentityInput): IdentityMode {
  const modes: IdentityMode[] = [];

  if (input.productId) modes.push({ mode: "PRODUCT_ID", value: input.productId });
  if (input.internalSku) modes.push({ mode: "INTERNAL_SKU", value: input.internalSku });
  if (input.orionCode) {
    modes.push({ mode: "ORION_CODE", value: normalizeOrionCode(input.orionCode) });
  }

  if (modes.length > 1) throw new SkuIdentityError("AMBIGUOUS_MODE");

  // `name` no se mira: un nombre no es identidad, ni siquiera cuando es el
  // único dato que llegó.
  const [only] = modes;
  if (!only) throw new SkuIdentityError("MISSING_EXACT_IDENTITY");

  return only;
}

/** La parte del producto que importa para decidir identidad. */
export type SkuIdentityRecord = {
  id: string;
  internalSku: string | null;
  orionCode: string | null;
};

export function assertIdentityMatches(
  input: IdentityInput,
  product: SkuIdentityRecord | null,
): void {
  if (!product) throw new SkuIdentityError("UNKNOWN_SKU");

  if (input.productId && input.productId !== product.id) {
    throw new SkuIdentityError("ID_SKU_MISMATCH");
  }

  if (input.internalSku && input.internalSku !== product.internalSku) {
    throw new SkuIdentityError("ID_SKU_MISMATCH");
  }
}

// --------------------------------------------------------------------------
// Vínculo con el código Orion.
//
// Devuelve un PLAN, no un efecto: quien escriba en la base decide cómo
// ejecutarlo, y esta función se puede probar sin base.
// --------------------------------------------------------------------------

export type OrionLinkPlan =
  | { action: "NOOP"; productId: string; orionCode: string }
  | { action: "LINK"; productId: string; orionCode: string }
  | {
      action: "RELINK";
      productId: string;
      orionCode: string;
      releasedFromProductId: string;
    }
  | {
      action: "FIX";
      productId: string;
      orionCode: string;
      /**
       * El código que se está reemplazando. Viaja en el plan porque es el
       * compare-and-set de la escritura: filtrar por él impide pisar un código
       * que cambió entre que se leyó el producto y que se escribió.
       */
      previousOrionCode: string;
    };

export function planOrionLink(params: {
  product: SkuIdentityRecord;
  orionCode: string;
  /** Producto que hoy tiene ese código Orion, si alguno lo tiene. */
  holder: SkuIdentityRecord | null;
  /**
   * `RELINK` y `FIX` son decisiones explícitas y auditadas, nunca efectos
   * colaterales. RELINK mueve un código de un producto a OTRO; FIX cambia el
   * código equivocado de ESTE producto por el correcto.
   */
  intent: "LINK" | "RELINK" | "FIX";
}): OrionLinkPlan {
  const orionCode = normalizeOrionCode(params.orionCode);
  const { product, holder, intent } = params;

  // Repetir el mismo vínculo no es conflicto ni escritura.
  if (product.orionCode === orionCode) {
    return { action: "NOOP", productId: product.id, orionCode };
  }

  // Un código ya puesto no se cambia por accidente. Solo `FIX` puede, porque
  // el código se copia a mano desde el ERP y quien lo copia está en el
  // mostrador: tipearlo mal es cuestión de tiempo, y sin una vía de corrección
  // el primer error sería permanente.
  //
  // Corregir hacia un código que YA tiene otro producto no se resuelve solo:
  // son dos productos y dos decisiones. Primero se libera aquel, después se
  // corrige este, y cada paso queda auditado por separado.
  if (product.orionCode !== null) {
    if (intent !== "FIX" || (holder && holder.id !== product.id)) {
      throw new SkuIdentityError("ORION_CONFLICT");
    }

    return {
      action: "FIX",
      productId: product.id,
      orionCode,
      previousOrionCode: product.orionCode,
    };
  }

  if (holder && holder.id !== product.id) {
    if (intent !== "RELINK") throw new SkuIdentityError("ORION_CONFLICT");

    return {
      action: "RELINK",
      productId: product.id,
      orionCode,
      releasedFromProductId: holder.id,
    };
  }

  return { action: "LINK", productId: product.id, orionCode };
}

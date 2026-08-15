// --------------------------------------------------------------------------
// Identidad de producto — reglas PURAS, sin base de datos.
//
// El código Orion es la identidad canónica e inmutable de un producto. Cuando
// un producto entra al catálogo sin ese código todavía, el servidor le acuña
// un SKU interno provisional (`PRV-{ULID}`) y lo deja marcado para revisión.
//
// Este archivo cubre quién puede acuñar identidad y cómo se genera. Las reglas
// de resolución exacta y de vínculo con el código Orion llegan aparte.
//
// Nada de esto toca Prisma: las reglas se prueban sin base, igual que
// `lib/auth/permissions.ts`.
// --------------------------------------------------------------------------

import type { SessionRole } from "@/lib/auth/session";

// --------------------------------------------------------------------------
// Errores tipados. La Server Action los mapea a un mensaje para el operador.
// --------------------------------------------------------------------------

export type SkuIdentityCode =
  /** El rol no puede acuñar identidad de producto. */
  | "FORBIDDEN_ACTOR"
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
// ven el catálogo, pero acuñar identidad canónica es otra cosa.
// --------------------------------------------------------------------------

export const SKU_ONBOARDING_ROLES: readonly SessionRole[] = [
  "SUPERADMIN",
  "ADMIN",
  "BODEGA",
];

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

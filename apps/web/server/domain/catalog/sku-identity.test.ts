import { describe, expect, it } from "vitest";

import {
  assertAttemptWithinBudget,
  assertCanOnboardSku,
  canOnboardSku,
  generateUlid,
  isProvisionalSku,
  PROVISIONAL_SKU_PREFIX,
  provisionalSkuFor,
  SKU_COLLISION_MAX_ATTEMPTS,
  SkuIdentityError,
  type SkuIdentityCode,
} from "./sku-identity";

function codeOf(run: () => unknown): SkuIdentityCode | "SIN ERROR" {
  try {
    run();
    return "SIN ERROR";
  } catch (error) {
    if (error instanceof SkuIdentityError) return error.code;
    throw error;
  }
}

const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

// Aleatoriedad fija: el ULID tiene que ser determinístico para poder probarlo.
const RANDOMNESS = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

describe("canOnboardSku", () => {
  it("autoriza a quienes reciben mercadería y a la administración", () => {
    for (const role of ["SUPERADMIN", "ADMIN", "BODEGA"] as const) {
      expect(canOnboardSku(role)).toBe(true);
    }
  });

  // Acuñar identidad canónica no es supervisar ni vender: quien no está en la
  // lista no crea SKU, aunque vea el catálogo.
  it("niega a supervisión y a los vendedores", () => {
    for (const role of ["SUPERVISOR", "OPERADOR"] as const) {
      expect(canOnboardSku(role)).toBe(false);
      expect(codeOf(() => assertCanOnboardSku(role))).toBe("FORBIDDEN_ACTOR");
    }
  });

  it("deja pasar al actor autorizado sin lanzar", () => {
    expect(() => assertCanOnboardSku("BODEGA")).not.toThrow();
  });
});

describe("generateUlid", () => {
  it("produce 26 caracteres del alfabeto Crockford", () => {
    expect(generateUlid(new Date("2026-08-14T21:00:00Z").getTime(), RANDOMNESS)).toMatch(
      CROCKFORD,
    );
  });

  it("es determinístico con el mismo instante y la misma aleatoriedad", () => {
    const at = new Date("2026-08-14T21:00:00Z").getTime();

    expect(generateUlid(at, RANDOMNESS)).toBe(generateUlid(at, RANDOMNESS));
  });

  // El prefijo temporal es lo que hace ordenables los SKU provisionales: sin
  // esto, dos altas del mismo día no tendrían orden estable.
  it("ordena lexicográficamente por instante de creación", () => {
    const earlier = generateUlid(new Date("2026-08-14T21:00:00Z").getTime(), RANDOMNESS);
    const later = generateUlid(new Date("2026-08-14T21:00:01Z").getTime(), RANDOMNESS);

    expect(earlier < later).toBe(true);
  });

  it("cambia cuando cambia la aleatoriedad, con el mismo instante", () => {
    const at = new Date("2026-08-14T21:00:00Z").getTime();
    const other = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);

    expect(generateUlid(at, RANDOMNESS)).not.toBe(generateUlid(at, other));
  });

  it("exige exactamente 10 bytes de aleatoriedad", () => {
    expect(() => generateUlid(Date.now(), new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe("provisionalSkuFor", () => {
  it("antepone el prefijo provisional al ULID", () => {
    const ulid = generateUlid(Date.now(), RANDOMNESS);

    expect(provisionalSkuFor(ulid)).toBe(`${PROVISIONAL_SKU_PREFIX}${ulid}`);
  });

  it("reconoce un SKU provisional y descarta cualquier otro", () => {
    expect(isProvisionalSku(provisionalSkuFor(generateUlid(Date.now(), RANDOMNESS)))).toBe(
      true,
    );

    // `PROV-{nombre}` es el código que hoy genera el alta desde reportes: NO es
    // un SKU provisional canónico, y no puede pasar por uno.
    for (const value of ["PROV-ibuprofeno", "7702001234567", "", "PRV-", "prv-abc"]) {
      expect(isProvisionalSku(value)).toBe(false);
    }
  });
});

describe("presupuesto de colisión", () => {
  // Presupuesto D2 aprobado: cinco intentos y se termina con un error
  // terminal. Reintentar para siempre esconde un problema real de generación.
  it("son cinco intentos", () => {
    expect(SKU_COLLISION_MAX_ATTEMPTS).toBe(5);
  });

  it("admite hasta el último intento del presupuesto", () => {
    for (let attempt = 1; attempt <= SKU_COLLISION_MAX_ATTEMPTS; attempt += 1) {
      expect(() => assertAttemptWithinBudget(attempt)).not.toThrow();
    }
  });

  it("agotado el presupuesto, el error es terminal", () => {
    expect(codeOf(() => assertAttemptWithinBudget(SKU_COLLISION_MAX_ATTEMPTS + 1))).toBe(
      "GENERATION_EXHAUSTED",
    );
  });
});

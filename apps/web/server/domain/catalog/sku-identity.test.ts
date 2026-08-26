import { describe, expect, it } from "vitest";

import {
  assertAttemptWithinBudget,
  assertCanFixSkuIdentity,
  assertCanLinkAtCapture,
  assertCanOnboardSku,
  assertIdentityMatches,
  canFixSkuIdentity,
  canLinkAtCapture,
  canOnboardSku,
  generateUlid,
  isProvisionalSku,
  normalizeOrionCode,
  planOrionLink,
  PROVISIONAL_SKU_PREFIX,
  provisionalSkuFor,
  resolveIdentityMode,
  SKU_CAPTURE_LINK_ROLES,
  SKU_COLLISION_MAX_ATTEMPTS,
  SKU_FIX_ROLES,
  SKU_ONBOARDING_ROLES,
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
const RANDOMNESS = new Uint8Array([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
]);

describe("canOnboardSku", () => {
  // SUPERVISOR entra porque resuelve la cola de identidad pendiente (S2b · 2-B2):
  // si ve la cola, tiene que poder vincular el código de Orion.
  it("autoriza a administración, bodega y supervisión", () => {
    for (const role of ["SUPERADMIN", "ADMIN", "SUPERVISOR", "BODEGA"] as const) {
      expect(canOnboardSku(role)).toBe(true);
    }
  });

  // OPERADOR no: su única corrección va por su propio pendiente, con el límite
  // de una sola vez que ya rige ahí.
  it("niega a OPERADOR", () => {
    expect(canOnboardSku("OPERADOR")).toBe(false);
    expect(codeOf(() => assertCanOnboardSku("OPERADOR"))).toBe("FORBIDDEN_ACTOR");
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
    const at = Date.now();

    expect(() => generateUlid(at, new Uint8Array([1, 2, 3]))).toThrow();
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

describe("normalizeOrionCode", () => {
  it("recorta los espacios de los extremos", () => {
    expect(normalizeOrionCode("  7702001234567  ")).toBe("7702001234567");
  });

  // La identidad es EXACTA: cambiarle las mayúsculas sería inventar otro código.
  it("conserva las mayúsculas y minúsculas tal cual", () => {
    expect(normalizeOrionCode("Ori-8842a")).toBe("Ori-8842a");
  });

  it("rechaza un código vacío o solo espacios", () => {
    for (const raw of ["", "   ", "\t\n"]) {
      expect(codeOf(() => normalizeOrionCode(raw))).toBe("MISSING_EXACT_IDENTITY");
    }
  });

  it("rechaza un código con espacios internos", () => {
    expect(codeOf(() => normalizeOrionCode("770200 1234567"))).toBe(
      "MISSING_EXACT_IDENTITY",
    );
  });
});

describe("resolveIdentityMode", () => {
  it("reconoce cada identidad exacta por separado", () => {
    expect(resolveIdentityMode({ productId: "p1" })).toEqual({
      mode: "PRODUCT_ID",
      value: "p1",
    });
    expect(resolveIdentityMode({ internalSku: "PRV-ABC" })).toEqual({
      mode: "INTERNAL_SKU",
      value: "PRV-ABC",
    });
    expect(resolveIdentityMode({ orionCode: " 7702001234567 " })).toEqual({
      mode: "ORION_CODE",
      value: "7702001234567",
    });
  });

  it("rechaza dos identidades exactas a la vez", () => {
    expect(codeOf(() => resolveIdentityMode({ productId: "p1", orionCode: "X1" }))).toBe(
      "AMBIGUOUS_MODE",
    );
  });

  it("rechaza no recibir ninguna identidad exacta", () => {
    expect(codeOf(() => resolveIdentityMode({}))).toBe("MISSING_EXACT_IDENTITY");
  });

  // ESTA es la regla del slice: el nombre no es identidad. Ni solo, ni
  // parecido, ni "el único que coincide". Nunca.
  it("nunca establece identidad por nombre", () => {
    expect(codeOf(() => resolveIdentityMode({ name: "Ibuprofeno 400mg" }))).toBe(
      "MISSING_EXACT_IDENTITY",
    );
  });

  it("ignora el nombre cuando viene junto a una identidad exacta", () => {
    expect(
      resolveIdentityMode({ productId: "p1", name: "Ibuprofeno 400mg" }),
    ).toEqual({ mode: "PRODUCT_ID", value: "p1" });
  });
});

describe("assertIdentityMatches", () => {
  const product = { id: "p1", internalSku: "PRV-ABC", orionCode: "7702001234567" };

  it("acepta el producto que corresponde a la identidad pedida", () => {
    expect(() =>
      assertIdentityMatches({ productId: "p1", internalSku: "PRV-ABC" }, product),
    ).not.toThrow();
  });

  it("rechaza cuando no hay producto para esa identidad", () => {
    expect(codeOf(() => assertIdentityMatches({ internalSku: "PRV-XYZ" }, null))).toBe(
      "UNKNOWN_SKU",
    );
  });

  // Id y SKU que apuntan a productos distintos: el llamador está trabajando
  // con datos viejos y no se puede adivinar cuál quiso.
  it("rechaza el id y el SKU que no coinciden entre sí", () => {
    expect(
      codeOf(() =>
        assertIdentityMatches({ productId: "p1", internalSku: "PRV-OTRO" }, product),
      ),
    ).toBe("ID_SKU_MISMATCH");
  });
});

describe("planOrionLink", () => {
  const target = { id: "p1", internalSku: "PRV-ABC", orionCode: null };
  const linked = { id: "p1", internalSku: "PRV-ABC", orionCode: "7702001234567" };
  const otro = { id: "p2", internalSku: "PRV-DEF", orionCode: "7702001234567" };

  it("vincula un código libre", () => {
    expect(
      planOrionLink({ product: target, orionCode: "7702001234567", holder: null, intent: "LINK" }),
    ).toEqual({ action: "LINK", productId: "p1", orionCode: "7702001234567" });
  });

  // Idempotencia: repetir el mismo vínculo no es un conflicto ni una escritura.
  it("no hace nada si el producto ya tiene ese mismo código", () => {
    expect(
      planOrionLink({
        product: linked,
        orionCode: "7702001234567",
        holder: linked,
        intent: "LINK",
      }),
    ).toEqual({ action: "NOOP", productId: "p1", orionCode: "7702001234567" });
  });

  // El código Orion es INMUTABLE: pisarlo silenciosamente rompería la
  // trazabilidad de todo el inventario del producto.
  it("rechaza cambiarle el código a un producto que ya tiene otro", () => {
    expect(
      codeOf(() =>
        planOrionLink({
          product: linked,
          orionCode: "7702009999999",
          holder: null,
          intent: "LINK",
        }),
      ),
    ).toBe("ORION_CONFLICT");
  });

  it("rechaza tomar un código que ya tiene otro producto", () => {
    expect(
      codeOf(() =>
        planOrionLink({
          product: target,
          orionCode: "7702001234567",
          holder: otro,
          intent: "LINK",
        }),
      ),
    ).toBe("ORION_CONFLICT");
  });

  // Mover un código de un producto a otro es una decisión explícita y auditada,
  // nunca un efecto colateral de un alta.
  it("permite mudar el código solo con intención explícita de remapeo", () => {
    expect(
      planOrionLink({
        product: target,
        orionCode: "7702001234567",
        holder: otro,
        intent: "RELINK",
      }),
    ).toEqual({
      action: "RELINK",
      productId: "p1",
      orionCode: "7702001234567",
      releasedFromProductId: "p2",
    });
  });

  it("rechaza el remapeo hacia un producto que ya tiene otro código", () => {
    expect(
      codeOf(() =>
        planOrionLink({
          product: linked,
          orionCode: "7702009999999",
          holder: otro,
          intent: "RELINK",
        }),
      ),
    ).toBe("ORION_CONFLICT");
  });
});

// --------------------------------------------------------------------------
// Corregir una identidad mal cargada.
//
// El código Orion se copia a mano desde el ERP, y quien lo copia suele estar en
// el mostrador con un cliente enfrente. Se va a tipear mal. Hasta ahora eso era
// permanente: `assignOrionCode` filtra por `orionCode: null`, así que un código
// ya puesto no se podía cambiar por ninguna vía.
//
// La razón escrita para esa inmutabilidad —"pisarlo rompería la trazabilidad de
// todo el inventario que ya se movió bajo ese código"— no se sostiene:
// `orionCode` aparece UNA sola vez en todo el esquema, en `products`. Los
// movimientos se anclan en `lotId`, y asignaciones, reservas y entradas en
// `productId`. Cambiar el código no huerfaniza una sola fila. Lo que sí se
// pierde es reconciliar hacia atrás contra Orion, y para eso está la auditoría,
// que se escribe en la misma transacción.
//
// FIX es distinto de RELINK: RELINK mueve un código de un producto a otro; FIX
// cambia el código equivocado de ESTE producto por el correcto.
// --------------------------------------------------------------------------
describe("corrección de identidad", () => {
  const conCodigo = { id: "p1", internalSku: "PRV-ABC", orionCode: "7702001234567" };
  const sinCodigo = { id: "p1", internalSku: "PRV-ABC", orionCode: null };
  const otro = { id: "p2", internalSku: "PRV-DEF", orionCode: "7702009999999" };

  it("cambia el código equivocado por el correcto", () => {
    expect(
      planOrionLink({
        product: conCodigo,
        orionCode: "7702009999999",
        holder: null,
        intent: "FIX",
      }),
    ).toEqual({
      action: "FIX",
      productId: "p1",
      orionCode: "7702009999999",
      // El anterior viaja en el plan porque es el compare-and-set de la
      // escritura: sin él se podría pisar un código que cambió en el medio.
      previousOrionCode: "7702001234567",
    });
  });

  // Que el corrector se equivoque de nuevo y escriba el código de un tercero no
  // puede resolverse solo: son dos productos y dos decisiones. Primero se libera
  // el otro, después se corrige este, y cada paso queda auditado por separado.
  it("rechaza corregir hacia un código que ya tiene otro producto", () => {
    expect(
      codeOf(() =>
        planOrionLink({
          product: conCodigo,
          orionCode: "7702009999999",
          holder: otro,
          intent: "FIX",
        }),
      ),
    ).toBe("ORION_CONFLICT");
  });

  it("corregir hacia el mismo código que ya tiene no escribe nada", () => {
    expect(
      planOrionLink({
        product: conCodigo,
        orionCode: "7702001234567",
        holder: conCodigo,
        intent: "FIX",
      }),
    ).toEqual({ action: "NOOP", productId: "p1", orionCode: "7702001234567" });
  });

  // Corregir un producto que todavía no tiene código no es un error del que
  // corrige: es la carrera de que alguien lo haya vinculado —o no— mientras
  // tenía el formulario abierto. Vale como alta normal; si la versión quedó
  // vieja, el compare-and-set de la escritura lo frena igual.
  it("sobre un producto sin código se comporta como un alta normal", () => {
    expect(
      planOrionLink({
        product: sinCodigo,
        orionCode: "7702001234567",
        holder: null,
        intent: "FIX",
      }),
    ).toEqual({ action: "LINK", productId: "p1", orionCode: "7702001234567" });
  });

  // La intención sigue siendo explícita: LINK nunca pisa un código puesto.
  it("LINK sigue sin poder cambiar un código ya puesto", () => {
    expect(
      codeOf(() =>
        planOrionLink({
          product: conCodigo,
          orionCode: "7702009999999",
          holder: null,
          intent: "LINK",
        }),
      ),
    ).toBe("ORION_CONFLICT");
  });
});

// --------------------------------------------------------------------------
// Quién corrige.
//
// El conjunto es MÁS ancho que el de acuñación, y a propósito: acuñar crea
// identidad nueva, corregir repara una que ya está mal. Supervisión entra
// porque es quien recibe el reclamo del vendedor; el vendedor NO, porque su
// única corrección va por su propio pendiente y con su límite de una sola vez.
// --------------------------------------------------------------------------
describe("canFixSkuIdentity", () => {
  it("habilita a superadmin, admin, supervisor y bodega", () => {
    for (const role of ["SUPERADMIN", "ADMIN", "SUPERVISOR", "BODEGA"] as const) {
      expect(canFixSkuIdentity(role)).toBe(true);
    }
    expect([...SKU_FIX_ROLES].sort()).toEqual(
      ["ADMIN", "BODEGA", "SUPERADMIN", "SUPERVISOR"].sort(),
    );
  });

  it("deja afuera al vendedor", () => {
    expect(canFixSkuIdentity("OPERADOR")).toBe(false);
    expect(codeOf(() => { assertCanFixSkuIdentity("OPERADOR"); })).toBe("FORBIDDEN_ACTOR");
  });
});

// Vincular AL CAPTURAR: cerradura más ancha que acuñar —el vendedor captura, y
// el que tiene el cliente enfrente es el que lee Orion— y estrictamente LINK.
describe("canLinkAtCapture", () => {
  it("habilita a los cinco roles que capturan", () => {
    for (const role of ["SUPERADMIN", "ADMIN", "SUPERVISOR", "OPERADOR", "BODEGA"] as const) {
      expect(canLinkAtCapture(role)).toBe(true);
    }
    expect([...SKU_CAPTURE_LINK_ROLES].sort()).toEqual(
      ["ADMIN", "BODEGA", "OPERADOR", "SUPERADMIN", "SUPERVISOR"].sort(),
    );
  });

  // SUPERVISOR entra porque resuelve la cola de identidad pendiente (S2b · 2-B2):
  // si ve la cola, tiene que poder actuar. OPERADOR no: su única corrección va
  // por su propio pendiente.
  it("incluye SUPERVISOR (resuelve la cola) y excluye OPERADOR", () => {
    expect([...SKU_ONBOARDING_ROLES].sort()).toEqual(
      ["ADMIN", "BODEGA", "SUPERADMIN", "SUPERVISOR"].sort(),
    );
  });

  // Los cinco roles reales capturan, así que el rechazo solo se ejercita con uno
  // inventado: es la línea que decide si un rol futuro escribe sin revisión.
  it("rechaza a un rol que no captura", () => {
    expect(codeOf(() => { assertCanLinkAtCapture("AUDITOR" as never); })).toBe("FORBIDDEN_ACTOR");
  });
});

describe("normalizeOrionCode · forma del código", () => {
  it("recorta los extremos y conserva las mayúsculas exactas", () => {
    expect(normalizeOrionCode("  7702-Ab  ")).toBe("7702-Ab");
  });

  it("rechaza whitespace interno Unicode y BOM", () => {
    for (const raw of [
      "7702 001",
      "7702\t001",
      "7702\n001",
      "7702\u0085001",
      "7702\u00A0001",
      "7702\uFEFF001",
    ]) {
      expect(codeOf(() => normalizeOrionCode(raw))).toBe("MISSING_EXACT_IDENTITY");
    }
  });

  it("acepta 80 y rechaza 81 en ASCII", () => {
    expect(normalizeOrionCode("7".repeat(80))).toHaveLength(80);
    expect(codeOf(() => normalizeOrionCode("7".repeat(81)))).toBe("MISSING_EXACT_IDENTITY");
  });

  // El límite cuenta CARACTERES Unicode, no unidades UTF-16. Un par suplente
  // ocupa dos unidades: con `.length` estos 80 caracteres medirían 160 y se
  // rechazarían, y `char_length` de PostgreSQL —que es lo que acota la columna—
  // diría 80. Medir distinto que la base es rechazar códigos que la base acepta.
  it("cuenta caracteres, no unidades: 80 astrales entran, 81 no", () => {
    const astral = "𝔸";
    expect(astral).toHaveLength(2);

    expect([...normalizeOrionCode(astral.repeat(80))]).toHaveLength(80);
    expect(codeOf(() => normalizeOrionCode(astral.repeat(81)))).toBe("MISSING_EXACT_IDENTITY");
  });
});

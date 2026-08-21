import { describe, expect, it } from "vitest";

import { orionLinkSchema, productCreateSchema } from "./schema";

describe("productCreateSchema", () => {
  it("acepta un producto válido y coerciona números", () => {
    const result = productCreateSchema.safeParse({
      code: "  SKU-010 ",
      name: "Amoxicilina 500mg",
      unit: "caja",
      minStock: "10",
      reorderQty: "25",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe("SKU-010"); // trim
      expect(result.data.minStock).toBe(10); // coerción a number
    }
  });

  it("rechaza código vacío", () => {
    const result = productCreateSchema.safeParse({
      code: "",
      name: "X",
      unit: "u",
    });
    expect(result.success).toBe(false);
  });

  it("aplica defaults de stock cuando faltan", () => {
    const result = productCreateSchema.safeParse({
      code: "SKU-011",
      name: "Diclofenaco",
      unit: "caja",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.minStock).toBe(0);
      expect(result.data.reorderQty).toBe(0);
    }
  });
});


// El formulario es la primera barrera, no la única: el dominio vuelve a
// validar. Lo que se gana acá es el MENSAJE — `normalizeOrionCode` rechaza un
// código con espacios con `MISSING_EXACT_IDENTITY`, que al operador no le dice
// nada. Atajarlo antes permite explicarle qué escribió mal.

describe("orionLinkSchema", () => {
  const valid = {
    productId: "prod-1",
    orionCode: "7702057012345",
    expectedVersion: "0",
  };

  it("accepts a well-formed submission and coerces the version", () => {
    const parsed = orionLinkSchema.safeParse(valid);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({
      productId: "prod-1",
      orionCode: "7702057012345",
      expectedVersion: 0,
    });
  });

  it("trims the surrounding whitespace of the code", () => {
    const parsed = orionLinkSchema.safeParse({ ...valid, orionCode: "  ABC-1  " });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.orionCode).toBe("ABC-1");
  });

  it("preserves the case of the code, because identity is exact", () => {
    const parsed = orionLinkSchema.safeParse({ ...valid, orionCode: "aBc-1" });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.orionCode).toBe("aBc-1");
  });

  it("rejects a code with inner whitespace instead of letting the domain do it", () => {
    const parsed = orionLinkSchema.safeParse({ ...valid, orionCode: "ABC 1" });

    expect(parsed.success).toBe(false);
  });

  it("rejects a blank code", () => {
    expect(orionLinkSchema.safeParse({ ...valid, orionCode: "   " }).success).toBe(false);
  });

  it("rejects a missing product", () => {
    expect(orionLinkSchema.safeParse({ ...valid, productId: "" }).success).toBe(false);
  });

  it("rejects a negative or non-numeric version", () => {
    expect(orionLinkSchema.safeParse({ ...valid, expectedVersion: "-1" }).success).toBe(
      false,
    );
    expect(orionLinkSchema.safeParse({ ...valid, expectedVersion: "x" }).success).toBe(
      false,
    );
  });

  it("rejects a version that is not a whole number", () => {
    expect(orionLinkSchema.safeParse({ ...valid, expectedVersion: "1.5" }).success).toBe(
      false,
    );
  });
});

// --------------------------------------------------------------------------
// Hallazgo de la revisión del 20/8/2026.
//
// `z.coerce.number()` corre `Number(valor)` ANTES de mirar `.int()` y
// `.min(0)`, y `Number("")` y `Number(null)` son 0. O sea que un campo vacío
// —o directamente ausente, porque `formData.get()` devuelve `null`— entraba
// como "vi la versión 0", que es la afirmación que el compare-and-set existe
// para hacer con honestidad. Un producto que nadie tocó está justo en la
// versión 0, así que ese pase libre alcanzaba a casi todo el catálogo.
//
// No alcanza con no mandarlo desde el formulario: la Server Action es una
// puerta pública y tiene que rechazarlo por su cuenta.
// --------------------------------------------------------------------------
describe("orionLinkSchema · la versión no se inventa sola", () => {
  const base = { productId: "prod-1", orionCode: "ABC-1" };

  it("rechaza una versión vacía en vez de leerla como 0", () => {
    expect(orionLinkSchema.safeParse({ ...base, expectedVersion: "" }).success).toBe(false);
  });

  it("rechaza el campo ausente, que en un FormData llega como null", () => {
    expect(orionLinkSchema.safeParse({ ...base, expectedVersion: null }).success).toBe(false);
    expect(orionLinkSchema.safeParse(base).success).toBe(false);
  });

  it("rechaza una versión que son solo espacios", () => {
    expect(orionLinkSchema.safeParse({ ...base, expectedVersion: "   " }).success).toBe(false);
  });

  it("rechaza notación que parece número pero no es un conteo", () => {
    for (const raro of ["1e3", "0x10", "+1", "Infinity"]) {
      expect(orionLinkSchema.safeParse({ ...base, expectedVersion: raro }).success).toBe(false);
    }
  });
});

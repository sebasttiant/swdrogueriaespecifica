import { describe, expect, it } from "vitest";

import { orionLinkSchema } from "./sku-schema";

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

import { describe, expect, it } from "vitest";

import {
  canonicalOrionCode,
  isSameOrionIdentity,
  orionCodeVariants,
  orionNumericCore,
} from "./orion-code";

// Los casos salen de producción (31/10/2026): los cuatro formatos que convivían
// y los productos reales que quedaron partidos por culpa de eso.
describe("orionNumericCore", () => {
  it("reconoce el mismo producto en los cuatro formatos que usa la droguería", () => {
    expect(orionNumericCore("A15637")).toBe("15637");
    expect(orionNumericCore("A-15637")).toBe("15637");
    expect(orionNumericCore("15637")).toBe("15637");
    expect(orionNumericCore("SKU15637")).toBe("15637");
    expect(orionNumericCore("sku15637")).toBe("15637");
    expect(orionNumericCore("a-15637")).toBe("15637");
  });

  it("ignora los espacios de alrededor", () => {
    expect(orionNumericCore("  a-20956  ")).toBe("20956");
  });

  it("NO recorta la letra cuando lo que queda no es un número", () => {
    // `ABC123` no es "A" + "BC123": es un código fuera de la convención, y
    // recortarlo inventaría una identidad que nadie escribió.
    expect(orionNumericCore("ABC123")).toBe("ABC123");
    expect(orionNumericCore("SKUX")).toBe("SKUX");
  });
});

describe("canonicalOrionCode", () => {
  it("guarda siempre como lo muestra Orión: A + número", () => {
    expect(canonicalOrionCode("15637")).toBe("A15637");
    expect(canonicalOrionCode("a-15637")).toBe("A15637");
    expect(canonicalOrionCode("SKU15637")).toBe("A15637");
    expect(canonicalOrionCode("A15637")).toBe("A15637");
  });

  it("es idempotente: aplicarlo dos veces da lo mismo", () => {
    const once = canonicalOrionCode("sku20956");
    expect(canonicalOrionCode(once)).toBe(once);
  });

  it("respeta los códigos que no siguen la convención", () => {
    expect(canonicalOrionCode("ABC123")).toBe("ABC123");
  });
});

describe("isSameOrionIdentity", () => {
  it("empareja las cinco copias reales de ROZELAIC", () => {
    const copias = ["sku20956", "SKU20956", "a-20956", "20956", "A-20956"];
    for (const copia of copias) {
      expect(isSameOrionIdentity(copia, "A20956")).toBe(true);
    }
  });

  it("NO empareja números distintos", () => {
    expect(isSameOrionIdentity("A15637", "A15638")).toBe(false);
    expect(isSameOrionIdentity("20956", "a-21426")).toBe(false);
  });
});

describe("orionCodeVariants", () => {
  it("enumera las grafías que la droguería ya escribió en producción", () => {
    expect(orionCodeVariants("20956")).toEqual([
      "20956",
      "A20956",
      "A-20956",
      "SKU20956",
    ]);
  });

  it("parte de cualquier grafía y llega al mismo set", () => {
    expect(orionCodeVariants("a-20956")).toEqual(orionCodeVariants("SKU20956"));
  });

  it("fuera de convención solo se busca a sí mismo", () => {
    expect(orionCodeVariants("ABC123")).toEqual(["ABC123"]);
  });
});

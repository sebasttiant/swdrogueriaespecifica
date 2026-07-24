import { describe, expect, it } from "vitest";

import { formatPhone, normalizePhone } from "./phone";

describe("normalizePhone", () => {
  // La razón de ser del módulo: el mismo número dictado de cinco formas tiene
  // que quedar guardado una sola vez, o buscar un cliente por teléfono falla.
  it("colapsa las formas de escribir un mismo celular", () => {
    const variants = [
      "3001234567",
      "300 123 4567",
      "300-123-4567",
      "(300) 123-4567",
      "  300.123.4567  ",
    ];

    const normalized = variants.map((value) => normalizePhone(value));

    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe("3001234567");
  });

  it("acepta un fijo de 7 dígitos", () => {
    expect(normalizePhone("234 5678")).toBe("2345678");
  });

  it("conserva el prefijo internacional cuando abre el número", () => {
    expect(normalizePhone("+57 300 123 4567")).toBe("+573001234567");
  });

  it("rechaza un número demasiado corto para ser un teléfono", () => {
    expect(normalizePhone("300")).toBeNull();
    expect(normalizePhone("12345")).toBeNull();
  });

  it("rechaza un número más largo que cualquier teléfono real", () => {
    expect(normalizePhone("1234567890123456")).toBeNull();
  });

  it("rechaza texto que no es un teléfono", () => {
    expect(normalizePhone("no tiene")).toBeNull();
    expect(normalizePhone("300 123 4567 ext 2")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
  });

  // Un "+" en el medio significa que el texto no era un teléfono. Limpiarlo en
  // silencio guardaría un número que nadie escribió.
  it("rechaza un + que no abre el número en vez de ignorarlo", () => {
    expect(normalizePhone("300+1234567")).toBeNull();
  });

  it("rechaza un pegado accidental de texto largo", () => {
    expect(normalizePhone("3".repeat(41))).toBeNull();
  });
});

describe("formatPhone", () => {
  it("agrupa el celular colombiano como se dicta", () => {
    expect(formatPhone("3001234567")).toBe("300 123 4567");
  });

  // Agrupar un formato desconocido lo haría más difícil de leer, no menos.
  it("deja intacto lo que no es un celular de 10 dígitos", () => {
    expect(formatPhone("2345678")).toBe("2345678");
    expect(formatPhone("+573001234567")).toBe("+573001234567");
  });
});

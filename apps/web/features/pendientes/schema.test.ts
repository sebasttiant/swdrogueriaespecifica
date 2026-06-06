import { describe, expect, it } from "vitest";

import { pendingCreateSchema } from "./schema";

describe("pendingCreateSchema", () => {
  it("acepta un pendiente válido y coerciona la cantidad", () => {
    const result = pendingCreateSchema.safeParse({
      productId: "prod_123",
      quantity: "5",
      customerName: "  Ana Pérez ",
      note: "  Llamar al recibir ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.quantity).toBe(5); // coerción a number
      expect(result.data.customerName).toBe("Ana Pérez"); // trim
      expect(result.data.note).toBe("Llamar al recibir");
    }
  });

  it("normaliza textos opcionales vacíos a undefined", () => {
    const result = pendingCreateSchema.safeParse({
      productId: "prod_123",
      quantity: "2",
      customerName: "   ",
      note: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.customerName).toBeUndefined();
      expect(result.data.note).toBeUndefined();
    }
  });

  it("rechaza un pendiente sin producto", () => {
    const result = pendingCreateSchema.safeParse({
      productId: "",
      quantity: "1",
    });
    expect(result.success).toBe(false);
  });

  it("rechaza cantidad menor a 1", () => {
    const result = pendingCreateSchema.safeParse({
      productId: "prod_123",
      quantity: "0",
    });
    expect(result.success).toBe(false);
  });

  it("rechaza cantidad no entera", () => {
    const result = pendingCreateSchema.safeParse({
      productId: "prod_123",
      quantity: "1.5",
    });
    expect(result.success).toBe(false);
  });
});

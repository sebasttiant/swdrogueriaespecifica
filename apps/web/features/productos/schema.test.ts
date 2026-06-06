import { describe, expect, it } from "vitest";

import { productCreateSchema } from "./schema";

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

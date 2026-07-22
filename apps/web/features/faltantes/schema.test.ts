import { describe, expect, it } from "vitest";

import { manualMissingItemCreateSchema, orderMissingItemSchema } from "./schema";

// Base válida reutilizable; cada test sobreescribe lo que necesita probar.
const validInput = {
  missingItemId: "missing-1",
};

describe("orderMissingItemSchema", () => {
  it("rechaza supplierId + name a la vez (ambiguo)", () => {
    const result = orderMissingItemSchema.safeParse({
      ...validInput,
      supplierId: "sup-1",
      name: "Droguería Central",
    });
    expect(result.success).toBe(false);
  });

  it("rechaza supplierId + phone/address/email a la vez, aun sin name (ambiguo)", () => {
    const result = orderMissingItemSchema.safeParse({
      ...validInput,
      supplierId: "sup-1",
      phone: "555",
      address: "Calle 1",
      email: "ventas@central.test",
    });
    expect(result.success).toBe(false);
  });

  it("acepta supplierId solo: los campos de proveedor nuevo quedan undefined", () => {
    const result = orderMissingItemSchema.safeParse({
      ...validInput,
      supplierId: "sup-1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supplierId).toBe("sup-1");
      expect(result.data.name).toBeUndefined();
      expect(result.data.phone).toBeUndefined();
      expect(result.data.address).toBeUndefined();
      expect(result.data.email).toBeUndefined();
    }
  });

  it("acepta proveedor nuevo (sin supplierId) cuando viene el nombre", () => {
    const result = orderMissingItemSchema.safeParse({
      ...validInput,
      name: "Droguería Central",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supplierId).toBeUndefined();
      expect(result.data.name).toBe("Droguería Central");
    }
  });

  it("rechaza cuando falta supplierId y también falta name", () => {
    const result = orderMissingItemSchema.safeParse({ ...validInput });
    expect(result.success).toBe(false);
  });

  it("un supplierId de solo espacios se trata como ausente: exige name", () => {
    const result = orderMissingItemSchema.safeParse({
      ...validInput,
      supplierId: "   ",
    });
    expect(result.success).toBe(false);

    const withName = orderMissingItemSchema.safeParse({
      ...validInput,
      supplierId: "   ",
      name: "Droguería Central",
    });
    expect(withName.success).toBe(true);
    if (withName.success) {
      expect(withName.data.supplierId).toBeUndefined();
      expect(withName.data.name).toBe("Droguería Central");
    }
  });

  it("rechaza sin missingItemId", () => {
    const result = orderMissingItemSchema.safeParse({
      supplierId: "sup-1",
    });
    expect(result.success).toBe(false);
  });
});

describe("manualMissingItemCreateSchema", () => {
  it("accepts an existing catalog product, positive quantity, and trims the optional note", () => {
    const result = manualMissingItemCreateSchema.safeParse({
      productId: "  prod-1  ",
      quantity: "3",
      note: "  Prioridad mostrador  ",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        productId: "prod-1",
        quantity: 3,
        note: "Prioridad mostrador",
      });
    }
  });

  it("normalizes an empty note to undefined", () => {
    const result = manualMissingItemCreateSchema.safeParse({
      productId: "prod-1",
      quantity: "1",
      note: "   ",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.note).toBeUndefined();
    }
  });

  it("rejects missing productId and non-positive quantities", () => {
    expect(
      manualMissingItemCreateSchema.safeParse({ productId: "", quantity: "1" }).success,
    ).toBe(false);
    expect(
      manualMissingItemCreateSchema.safeParse({ productId: "prod-1", quantity: "0" }).success,
    ).toBe(false);
  });
});

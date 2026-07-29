import { describe, expect, it } from "vitest";

import {
  linkMissingReportSchema,
  MAX_LINKED_REPORTS,
  MAX_MISSING_REPORT_NAME_LENGTH,
  MAX_MISSING_REPORT_SELLER_CODE_LENGTH,
  MAX_ORDERED_QUANTITY,
  manualMissingItemCreateSchema,
  missingReportSubmitSchema,
  orderMissingItemSchema,
} from "./schema";

describe("missingReportSubmitSchema", () => {
  it("accepts a normal product name and trims it", () => {
    const result = missingReportSubmitSchema.safeParse({ rawName: "  Acetaminofén 500  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.rawName).toBe("Acetaminofén 500");
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(missingReportSubmitSchema.safeParse({ rawName: "" }).success).toBe(false);
    expect(missingReportSubmitSchema.safeParse({ rawName: "   " }).success).toBe(false);
  });

  it("rejects a missing name", () => {
    expect(missingReportSubmitSchema.safeParse({}).success).toBe(false);
  });

  it("accepts the maximum length and rejects one character over it", () => {
    const atLimit = "a".repeat(MAX_MISSING_REPORT_NAME_LENGTH);
    const overLimit = "a".repeat(MAX_MISSING_REPORT_NAME_LENGTH + 1);
    expect(missingReportSubmitSchema.safeParse({ rawName: atLimit }).success).toBe(true);
    expect(missingReportSubmitSchema.safeParse({ rawName: overLimit }).success).toBe(false);
  });

  // rawName se conserva tal cual (para mostrar): el schema no lo baja a
  // minúsculas ni colapsa espacios internos — eso es normalización, del service.
  it("preserves the raw name's case and inner spacing for display", () => {
    const result = missingReportSubmitSchema.safeParse({ rawName: "ACME   Gel" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.rawName).toBe("ACME   Gel");
  });

  // Clave del contrato con el service: un nombre de solo caracteres de control
  // PASA el schema (el `trim` nativo no los elimina), así que la validación de
  // "normaliza a vacío" DEBE vivir en el service, no acá.
  it("lets a control-character-only name through, leaving the empty check to the service", () => {
    const result = missingReportSubmitSchema.safeParse({ rawName: "\u0000\u0001\u001f" });
    expect(result.success).toBe(true);
  });

  it("trims an optional seller code, normalizes blank input, and bounds it to 40 characters", () => {
    const withCode = missingReportSubmitSchema.safeParse({
      rawName: "Gasa",
      sellerCode: "  VEN-12  ",
    });
    expect(withCode.success).toBe(true);
    if (withCode.success) expect(withCode.data.sellerCode).toBe("VEN-12");

    const blankCode = missingReportSubmitSchema.safeParse({ rawName: "Gasa", sellerCode: "   " });
    expect(blankCode.success).toBe(true);
    if (blankCode.success) expect(blankCode.data.sellerCode).toBeUndefined();

    expect(
      missingReportSubmitSchema.safeParse({
        rawName: "Gasa",
        sellerCode: "x".repeat(MAX_MISSING_REPORT_SELLER_CODE_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

// Base válida reutilizable; cada test sobreescribe lo que necesita probar.
// La cantidad a pedir es obligatoria: gerencia define explícitamente cuánto
// se compra, nunca se deriva de la necesidad histórica.
const validInput = {
  missingItemId: "missing-1",
  orderedQuantity: "20",
};

describe("orderMissingItemSchema · orderedQuantity", () => {
  function parseQuantity(orderedQuantity: unknown) {
    return orderMissingItemSchema.safeParse({
      missingItemId: "missing-1",
      supplierId: "sup-1",
      orderedQuantity,
    });
  }

  it("exige la cantidad a pedir", () => {
    expect(parseQuantity(undefined).success).toBe(false);
    expect(parseQuantity("").success).toBe(false);
  });

  it("acepta un entero positivo y lo coacciona a número", () => {
    const result = parseQuantity("20");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.orderedQuantity).toBe(20);
  });

  it("rechaza cero y negativos", () => {
    expect(parseQuantity("0").success).toBe(false);
    expect(parseQuantity("-5").success).toBe(false);
  });

  it("rechaza decimales", () => {
    expect(parseQuantity("2.5").success).toBe(false);
  });

  it("rechaza NaN, Infinity y strings ambiguos", () => {
    expect(parseQuantity("abc").success).toBe(false);
    expect(parseQuantity("Infinity").success).toBe(false);
    expect(parseQuantity(Number.NaN).success).toBe(false);
    expect(parseQuantity(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it("acepta el máximo y rechaza por encima del límite del schema", () => {
    expect(parseQuantity(String(MAX_ORDERED_QUANTITY)).success).toBe(true);
    expect(parseQuantity(String(MAX_ORDERED_QUANTITY + 1)).success).toBe(false);
  });
});

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
  it("accepts an existing catalog product and trims optional seller code and note", () => {
    const result = manualMissingItemCreateSchema.safeParse({
      productId: "  prod-1  ",
      sellerCode: "  VEN-12  ",
      note: "  Prioridad mostrador  ",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        productId: "prod-1",
        sellerCode: "VEN-12",
        note: "Prioridad mostrador",
      });
    }
  });

  it("normalizes an empty note to undefined", () => {
    const result = manualMissingItemCreateSchema.safeParse({
      productId: "prod-1",
      sellerCode: "   ",
      note: "   ",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.note).toBeUndefined();
      expect(result.data.sellerCode).toBeUndefined();
    }
  });

  it("rejects a missing productId and seller codes longer than 40 characters", () => {
    expect(
      manualMissingItemCreateSchema.safeParse({ productId: "" }).success,
    ).toBe(false);
    expect(
      manualMissingItemCreateSchema.safeParse({ productId: "prod-1", sellerCode: "x".repeat(41) }).success,
    ).toBe(false);
  });
});

describe("linkMissingReportSchema", () => {
  it("accepts a group of report ids and a product id", () => {
    const result = linkMissingReportSchema.safeParse({
      reportIds: ["r1", "r2"],
      productId: "prod-1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reportIds).toEqual(["r1", "r2"]);
      expect(result.data.productId).toBe("prod-1");
    }
  });

  it("rejects an empty report list", () => {
    expect(
      linkMissingReportSchema.safeParse({ reportIds: [], productId: "prod-1" }).success,
    ).toBe(false);
  });

  it("rejects a blank or missing product", () => {
    expect(
      linkMissingReportSchema.safeParse({ reportIds: ["r1"], productId: "  " }).success,
    ).toBe(false);
    expect(
      linkMissingReportSchema.safeParse({ reportIds: ["r1"] }).success,
    ).toBe(false);
  });

  it("rejects blank ids inside the report list", () => {
    expect(
      linkMissingReportSchema.safeParse({ reportIds: ["r1", "  "], productId: "p1" })
        .success,
    ).toBe(false);
  });
});

describe("linkMissingReportSchema · group hygiene", () => {
  it("deduplicates repeated report ids", () => {
    const result = linkMissingReportSchema.safeParse({
      reportIds: ["r1", "r2", "r1"],
      productId: "p1",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reportIds).toEqual(["r1", "r2"]);
  });

  it("caps an absurdly large group", () => {
    const tooMany = Array.from({ length: MAX_LINKED_REPORTS + 1 }, (_, i) => `r${i}`);
    expect(
      linkMissingReportSchema.safeParse({ reportIds: tooMany, productId: "p1" }).success,
    ).toBe(false);
  });
});

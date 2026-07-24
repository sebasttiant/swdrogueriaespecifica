import { describe, expect, it } from "vitest";

import {
  pendingCancelSchema,
  pendingCreateSchema,
  pendingDeliverSchema,
  pendingManagementStatusSchema,
} from "./schema";

// Base válida reutilizable; cada test sobreescribe lo que necesita probar.
const validInput = {
  productId: "prod_123",
  quantity: "5",
  promisedAt: "2026-06-09T14:30",
};

describe("pendingCreateSchema", () => {
  it("acepta un pendiente válido y coerciona cantidad y fecha", () => {
    const result = pendingCreateSchema.safeParse({
      ...validInput,
      customerName: "  Ana Pérez ",
      note: "  Llamar al recibir ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.quantity).toBe(5); // coerción a number
      // La promesa se interpreta como hora de Colombia (UTC-5), no del server.
      expect(result.data.promisedAt.toISOString()).toBe(
        "2026-06-09T19:30:00.000Z",
      );
      expect(result.data.customerName).toBe("Ana Pérez"); // trim
      expect(result.data.note).toBe("Llamar al recibir");
    }
  });

  it("normaliza textos opcionales vacíos a undefined", () => {
    const result = pendingCreateSchema.safeParse({
      ...validInput,
      customerName: "   ",
      note: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.customerName).toBeUndefined();
      expect(result.data.note).toBeUndefined();
    }
  });

  it("rechaza un pendiente sin producto (ni catálogo ni manual)", () => {
    const result = pendingCreateSchema.safeParse({ ...validInput, productId: "" });
    expect(result.success).toBe(false);
  });

  it("normaliza el productId del catálogo y no arma producto manual", () => {
    const result = pendingCreateSchema.safeParse(validInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.productId).toBe("prod_123");
      expect(result.data.manual).toBeUndefined();
    }
  });

  it("acepta un producto manual (sin productId) y usa la unidad indicada", () => {
    const { productId: _omit, ...withoutProduct } = validInput;
    const result = pendingCreateSchema.safeParse({
      ...withoutProduct,
      manualName: "  Ibuprofeno jarabe  ",
      manualUnit: "  frasco ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.productId).toBeUndefined();
      expect(result.data.manual).toEqual({ name: "Ibuprofeno jarabe", unit: "frasco" });
    }
  });

  it("producto manual sin unidad: usa 'unidad' por defecto", () => {
    const { productId: _omit, ...withoutProduct } = validInput;
    const result = pendingCreateSchema.safeParse({
      ...withoutProduct,
      manualName: "Ibuprofeno jarabe",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.manual).toEqual({
        name: "Ibuprofeno jarabe",
        unit: "unidad",
      });
    }
  });

  it("rechaza cargar catálogo y manual a la vez (ambiguo)", () => {
    const result = pendingCreateSchema.safeParse({
      ...validInput,
      manualName: "Ibuprofeno jarabe",
    });
    expect(result.success).toBe(false);
  });

  it("rechaza cantidad menor a 1", () => {
    const result = pendingCreateSchema.safeParse({ ...validInput, quantity: "0" });
    expect(result.success).toBe(false);
  });

  it("rechaza cantidad no entera", () => {
    const result = pendingCreateSchema.safeParse({
      ...validInput,
      quantity: "1.5",
    });
    expect(result.success).toBe(false);
  });

  it("rechaza la ausencia de promesa de entrega", () => {
    const { promisedAt: _omit, ...withoutPromise } = validInput;
    const result = pendingCreateSchema.safeParse(withoutPromise);
    expect(result.success).toBe(false);
  });

  it("rechaza una promesa vacía", () => {
    const result = pendingCreateSchema.safeParse({ ...validInput, promisedAt: "" });
    expect(result.success).toBe(false);
  });

  it("rechaza una promesa null", () => {
    const result = pendingCreateSchema.safeParse({
      ...validInput,
      promisedAt: null,
    });
    expect(result.success).toBe(false);
  });

  it("rechaza una promesa con fecha/hora inválida", () => {
    const result = pendingCreateSchema.safeParse({
      ...validInput,
      promisedAt: "2026-02-30T10:00",
    });
    expect(result.success).toBe(false);
  });

  it("acepta una fecha/hora prometida válida", () => {
    const result = pendingCreateSchema.safeParse({
      ...validInput,
      promisedAt: "2026-12-31T23:59",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // 23:59 Colombia del 31/12 → 04:59Z del 01/01 siguiente.
      expect(result.data.promisedAt.toISOString()).toBe(
        "2027-01-01T04:59:00.000Z",
      );
    }
  });
});

describe("pendingDeliverSchema", () => {
  it("coerciona la cantidad a número entero", () => {
    const result = pendingDeliverSchema.safeParse({ id: "pend-1", quantity: "6" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.quantity).toBe(6);
  });

  it("rechaza id vacío", () => {
    const result = pendingDeliverSchema.safeParse({ id: "", quantity: "6" });
    expect(result.success).toBe(false);
  });

  it("rechaza cantidad menor a 1", () => {
    const result = pendingDeliverSchema.safeParse({ id: "pend-1", quantity: "0" });
    expect(result.success).toBe(false);
  });

  it("rechaza cantidad no entera", () => {
    const result = pendingDeliverSchema.safeParse({ id: "pend-1", quantity: "1.5" });
    expect(result.success).toBe(false);
  });
});

describe("pendingCancelSchema", () => {
  it("acepta un id sin motivo", () => {
    const result = pendingCancelSchema.safeParse({ id: "pend-1" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reason).toBeUndefined();
  });

  it("acepta y recorta un motivo", () => {
    const result = pendingCancelSchema.safeParse({ id: "pend-1", reason: "  Cliente desistió  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reason).toBe("Cliente desistió");
  });

  it("normaliza un motivo vacío a undefined", () => {
    const result = pendingCancelSchema.safeParse({ id: "pend-1", reason: "   " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reason).toBeUndefined();
  });

  it("rechaza id vacío", () => {
    const result = pendingCancelSchema.safeParse({ id: "" });
    expect(result.success).toBe(false);
  });
});

describe("pendingManagementStatusSchema", () => {
  it("acepta cada uno de los cuatro estados de gestión", () => {
    for (const status of ["SOLICITADO", "BUSQUEDA", "COTIZANDO", "AGOTADO"]) {
      const result = pendingManagementStatusSchema.safeParse({ id: "pend-1", status });
      expect(result.success).toBe(true);
    }
  });

  // No se puede forzar un estado del ciclo de entrega por esta vía.
  it("rechaza estados que no son de gestión", () => {
    for (const status of ["PENDIENTE", "PARCIAL", "ENTREGADO", "CANCELADO"]) {
      const result = pendingManagementStatusSchema.safeParse({ id: "pend-1", status });
      expect(result.success).toBe(false);
    }
  });

  it("rechaza id vacío o status ausente", () => {
    expect(pendingManagementStatusSchema.safeParse({ id: "", status: "SOLICITADO" }).success).toBe(
      false,
    );
    expect(pendingManagementStatusSchema.safeParse({ id: "pend-1" }).success).toBe(false);
  });
});

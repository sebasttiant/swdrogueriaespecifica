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
  // Obligatorios desde julio de 2026: un pendiente sin cliente ni teléfono ya
  // no es válido, así que forman parte de la base reutilizable.
  customerName: "Ana Pérez",
  customerPhone: "300 123 4567",
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

  it("normaliza los textos OPCIONALES vacíos a undefined", () => {
    const result = pendingCreateSchema.safeParse({ ...validInput, note: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.note).toBeUndefined();
  });

  // ------------------------------------------------------------------------
  // Cliente y teléfono: obligatorios desde julio de 2026. Un pendiente es un
  // compromiso con una persona concreta; sin teléfono no se le puede avisar.
  // ------------------------------------------------------------------------

  it("rechaza un pendiente sin nombre de cliente", () => {
    const { customerName: _omit, ...withoutName } = validInput;
    expect(pendingCreateSchema.safeParse(withoutName).success).toBe(false);
    expect(
      pendingCreateSchema.safeParse({ ...validInput, customerName: "   " }).success,
    ).toBe(false);
  });

  it("rechaza un pendiente sin teléfono", () => {
    const { customerPhone: _omit, ...withoutPhone } = validInput;
    expect(pendingCreateSchema.safeParse(withoutPhone).success).toBe(false);
    expect(
      pendingCreateSchema.safeParse({ ...validInput, customerPhone: "  " }).success,
    ).toBe(false);
  });

  it("guarda el teléfono en su forma canónica, no como se tipeó", () => {
    const result = pendingCreateSchema.safeParse({
      ...validInput,
      customerPhone: "(300) 123-4567",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.customerPhone).toBe("3001234567");
  });

  it("acepta una dirección de entrega y recorta los espacios", () => {
    const result = pendingCreateSchema.safeParse({
      ...validInput,
      customerAddress: "  Calle 10 #43-20, apto 301  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.customerAddress).toBe("Calle 10 #43-20, apto 301");
    }
  });

  it("deja la dirección en undefined cuando no viene: es opcional", () => {
    const result = pendingCreateSchema.safeParse(validInput);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.customerAddress).toBeUndefined();
  });

  it("rechaza un teléfono que no tiene forma de teléfono", () => {
    expect(
      pendingCreateSchema.safeParse({ ...validInput, customerPhone: "300" }).success,
    ).toBe(false);
    expect(
      pendingCreateSchema.safeParse({ ...validInput, customerPhone: "no tiene" }).success,
    ).toBe(false);
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

  // ------------------------------------------------------------------------
  // Seguimiento del cliente: zona y montos.
  // ------------------------------------------------------------------------

  it("guarda la zona en su forma canónica, no como se tipeó", () => {
    const result = pendingCreateSchema.safeParse({ ...validInput, zone: "  NORTE " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.zone).toBe("Norte");
  });

  it("deja la zona en undefined cuando llega vacía", () => {
    const result = pendingCreateSchema.safeParse({ ...validInput, zone: "   " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.zone).toBeUndefined();
  });

  // El operador escribe el monto como lo lee en el mostrador. Si el punto de
  // miles se interpretara como decimal, $45.000 se guardaría como $45.
  it("lee el punto como separador de miles, no como decimal", () => {
    const result = pendingCreateSchema.safeParse({
      ...validInput,
      totalAmount: "$ 45.000",
      paidAmount: "20.000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.totalAmount).toBe(45_000);
      expect(result.data.paidAmount).toBe(20_000);
    }
  });

  // La coma es el separador DECIMAL en es-CO. Borrarla daría 4500050 — cien
  // veces el valor real. Se rechaza para que el error sea visible.
  it("rechaza un monto con coma decimal en vez de adivinar el valor", () => {
    const result = pendingCreateSchema.safeParse({
      ...validInput,
      totalAmount: "45.000,50",
    });
    expect(result.success).toBe(false);
  });

  it("sin abono es cero, no undefined: el cliente no dejó plata", () => {
    const result = pendingCreateSchema.safeParse(validInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paidAmount).toBe(0);
      expect(result.data.totalAmount).toBeUndefined();
    }
  });

  it("acepta un abono sin total acordado (producto por cotizar)", () => {
    const result = pendingCreateSchema.safeParse({ ...validInput, paidAmount: "20.000" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paidAmount).toBe(20_000);
      expect(result.data.totalAmount).toBeUndefined();
    }
  });

  it("rechaza un abono mayor al total: al cargarlo es un typo", () => {
    const result = pendingCreateSchema.safeParse({
      ...validInput,
      totalAmount: "45.000",
      paidAmount: "60.000",
    });
    expect(result.success).toBe(false);
  });

  it("rechaza un monto negativo", () => {
    const result = pendingCreateSchema.safeParse({ ...validInput, paidAmount: "-1000" });
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

import { describe, expect, it } from "vitest";

import {
  pendingCancelSchema,
  pendingCreateSchema,
  pendingDeliverSchema,
  pendingManagementStatusSchema,
} from "./schema";
import { PENDING_IDENTITY_DEFERRAL_REASONS } from "./identity-deferral";

// Base válida reutilizable; cada test sobreescribe lo que necesita probar.
const validInput = {
  productId: "prod_123",
  quantity: "5",
  promisedAt: "2026-06-09T14:30",
  // Obligatorios desde julio de 2026: un pendiente sin cliente ni teléfono ya
  // no es válido, así que forman parte de la base reutilizable.
  customerName: "Ana Pérez",
  customerPhone: "300 123 4567",
  // T3: laboratorio solicitado.
  requestedLaboratoryId: "lab-1",
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
  // CLOSED_PARTIAL (T2.2b) también es del ciclo de entrega, no de gestión.
  it("rechaza estados que no son de gestión", () => {
    for (const status of ["PENDIENTE", "PARCIAL", "ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"]) {
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

// --------------------------------------------------------------------------
// Regresión de producción (2026-07-30): la pantalla postea el estado de COMPRAS
// que observó, y ese "todavía sin gestionar" es `POR_PEDIR`. El schema solo
// aceptaba los valores del enum viejo, así que gerencia recibía "No se pudo
// identificar el pendiente o el estado" en TODOS los pendientes y no podía
// marcar ninguno.
// --------------------------------------------------------------------------
describe("pendingManagementStatusSchema · estado observado", () => {
  it("acepta POR_PEDIR como estado observado", () => {
    const parsed = pendingManagementStatusSchema.safeParse({
      id: "pend-1",
      status: "SOLICITADO",
      expectedStatus: "POR_PEDIR",
    });

    expect(parsed.success).toBe(true);
  });

  it("sigue aceptando los estados de gestión y el PENDIENTE histórico", () => {
    for (const expectedStatus of ["PENDIENTE", "SOLICITADO", "BUSQUEDA", "COTIZANDO", "AGOTADO"]) {
      const parsed = pendingManagementStatusSchema.safeParse({
        id: "pend-1",
        status: "AGOTADO",
        expectedStatus,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("rechaza un estado observado que no existe", () => {
    const parsed = pendingManagementStatusSchema.safeParse({
      id: "pend-1",
      status: "SOLICITADO",
      expectedStatus: "ENTREGADO",
    });

    expect(parsed.success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// S2b · 1d — identidad Orion al capturar.
//
// Regla XOR: llega EXACTAMENTE uno de un código Orion o un aplazamiento
// estructurado. El schema no puede exigir "al menos uno" en la rama catálogo
// porque el producto elegido puede tener código ya; ese caso lo decide la
// acción contra la base. En la rama MANUAL sí lo exige: el producto todavía
// no existe, así que nunca tiene código.
// --------------------------------------------------------------------------

describe("pendingCreateSchema · identidad Orion", () => {
  it("acepta un código Orion y lo normaliza recortando los extremos", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      orionCode: "  ORN-1001  ",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identity).toEqual({ kind: "CODE", orionCode: "ORN-1001" });
    }
  });

  it("conserva las mayúsculas exactas del código: la identidad no se normaliza de caja", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      orionCode: "oRn-Ab",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identity).toEqual({ kind: "CODE", orionCode: "oRn-Ab" });
    }
  });

  it("rechaza un código con espacios internos", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      orionCode: "ORN 1001",
    });

    expect(parsed.success).toBe(false);
  });

  it("rechaza un código que supera el máximo de la base", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      orionCode: "A".repeat(81),
    });

    expect(parsed.success).toBe(false);
  });

  it("trata el campo vacío como identidad ausente, no como error", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      orionCode: "   ",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.identity).toBeUndefined();
  });

  it("acepta un aplazamiento con motivo de la lista cerrada", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      identitySkippedReason: "ORION_UNAVAILABLE",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identity).toEqual({
        kind: "DEFERRED",
        reason: "ORION_UNAVAILABLE",
        note: undefined,
      });
    }
  });

  it("acepta los cuatro motivos de la lista cerrada y ninguno más", () => {
    for (const reason of PENDING_IDENTITY_DEFERRAL_REASONS) {
      const parsed = pendingCreateSchema.safeParse({
        ...validInput,
        identitySkippedReason: reason,
      });
      expect(parsed.success).toBe(true);
    }

    const invalid = pendingCreateSchema.safeParse({
      ...validInput,
      identitySkippedReason: "ORION_CAIDO",
    });
    expect(invalid.success).toBe(false);
  });

  it("acepta una nota junto al aplazamiento", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      identitySkippedReason: "OTHER",
      identitySkippedNote: "  Lo trae el proveedor el jueves  ",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identity).toEqual({
        kind: "DEFERRED",
        reason: "OTHER",
        note: "Lo trae el proveedor el jueves",
      });
    }
  });

  it("rechaza una nota huérfana: sin aplazamiento no hay qué anotar", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      identitySkippedNote: "Sin motivo",
    });

    expect(parsed.success).toBe(false);
  });

  it("rechaza una nota junto a un código: la nota solo explica un aplazamiento", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      orionCode: "ORN-1001",
      identitySkippedNote: "Sin motivo",
    });

    expect(parsed.success).toBe(false);
  });

  it("rechaza código y aplazamiento a la vez: son EXCLUYENTES", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      orionCode: "ORN-1001",
      identitySkippedReason: "CODE_NOT_FOUND",
    });

    expect(parsed.success).toBe(false);
  });

  it("en la rama catálogo admite que no venga ninguno: el producto puede tener código", () => {
    const parsed = pendingCreateSchema.safeParse(validInput);

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.identity).toBeUndefined();
  });

  // LÍMITE DE ESTA UNIDAD: valida la FORMA de la identidad, no exige que
  // venga. La exigencia necesita que la acción reenvíe estos campos; sin ese
  // cableado un `required` acá rechazaría toda carga manual. Viajan juntos.
  it("todavía NO exige identidad en la rama manual: eso llega con el cableado", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      productId: undefined,
      manualName: "Crema nueva",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.identity).toBeUndefined();
  });

  it("acepta un producto manual con código", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      productId: undefined,
      manualName: "Crema nueva",
      orionCode: "ORN-777",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.manual?.name).toBe("Crema nueva");
      expect(parsed.data.identity).toEqual({ kind: "CODE", orionCode: "ORN-777" });
    }
  });

  // Un <select> que nadie tocó postea "", no ausencia. Si el vacío no se
  // trata como "no vino", TODO envío con el desplegable intacto se rechaza
  // pidiendo un motivo que el operador justamente no quiso elegir.
  it("trata el motivo vacío como aplazamiento ausente, no como error", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      orionCode: "ORN-1001",
      identitySkippedReason: "",
      identitySkippedNote: "",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identity).toEqual({ kind: "CODE", orionCode: "ORN-1001" });
    }
  });

  it("acepta el catálogo sin identidad aunque el formulario postee los campos vacíos", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      orionCode: "",
      identitySkippedReason: "",
      identitySkippedNote: "",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.identity).toBeUndefined();
  });

  it("rechaza una nota demasiado larga con un mensaje en castellano", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      identitySkippedReason: "OTHER",
      identitySkippedNote: "x".repeat(281),
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // El mensaje va al mostrador tal cual: un "Too big: expected string…"
      // deja al operador sin saber qué corregir.
      const [first] = parsed.error.issues;
      expect(first?.message).toMatch(/nota/i);
      expect(first?.message).not.toMatch(/Too big/);
    }
  });

  it("un código en blanco junto a un aplazamiento no rompe el XOR", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      orionCode: "   ",
      identitySkippedReason: "CODE_NOT_FOUND",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identity).toEqual({
        kind: "DEFERRED",
        reason: "CODE_NOT_FOUND",
        note: undefined,
      });
    }
  });

  it("acepta un producto manual aplazado", () => {
    const parsed = pendingCreateSchema.safeParse({
      ...validInput,
      productId: undefined,
      manualName: "Crema nueva",
      identitySkippedReason: "CODE_NOT_FOUND",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identity).toEqual({
        kind: "DEFERRED",
        reason: "CODE_NOT_FOUND",
        note: undefined,
      });
    }
  });
});

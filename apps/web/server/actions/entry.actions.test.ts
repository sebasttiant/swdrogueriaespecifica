import { beforeEach, describe, expect, it, vi } from "vitest";

// Aislamos la action: acá se prueba el BORDE —guard, qué le pasa al servicio y
// traducción del rechazo a algo que una persona pueda leer—, no la transacción,
// que tiene sus propios tests en el service.
//
// La action NO resuelve el laboratorio. El nombre viaja crudo al servicio, que
// lo resuelve DENTRO de su transacción; resolverlo acá dejaba laboratorios
// huérfanos cuando la entrada se rechazaba después.
// La clase vive DENTRO de `vi.hoisted` porque `vi.mock` se eleva por encima de
// todo el módulo: declarada afuera, la fábrica del mock la leería antes de que
// exista.
const {
  requireCapability,
  registerInventoryEntry,
  recordAudit,
  auditContextFromHeaders,
  revalidatePath,
  LaboratoryEvidenceConflictError,
  LaboratoryNameResolutionError,
  ProductIdentityRequiredError,
  ProductNotFoundError,
  ProductVersionConflictError,
} = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  registerInventoryEntry: vi.fn(),
  recordAudit: vi.fn(),
  auditContextFromHeaders: vi.fn(),
  revalidatePath: vi.fn(),
  ProductIdentityRequiredError: class extends Error {
    readonly productId: string;
    readonly productName: string;
    constructor(params: { productId: string; productName: string }) {
      super("product has no Orion code");
      this.productId = params.productId;
      this.productName = params.productName;
    }
  },
  LaboratoryNameResolutionError: class extends Error {
    readonly requestedName: string;
    constructor(requestedName: string) {
      super("laboratory name resolved to a different laboratory");
      this.requestedName = requestedName;
    }
  },
  ProductNotFoundError: class extends Error {
    constructor(readonly productId: string) {
      super("product not found");
    }
  },
  ProductVersionConflictError: class extends Error {
    constructor(
      readonly kind: "identity" | "catalog",
      readonly product: {
        id: string;
        name: string;
        orionCode: string | null;
        unit: string;
        identityVersion: number;
        catalogVersion: number;
      },
    ) {
      super(`product ${kind} version changed`);
    }
  },
  LaboratoryEvidenceConflictError: class extends Error {
    readonly batchCode: string;
    readonly existingLaboratoryName: string | null;
    constructor(params: { batchCode: string; existingLaboratoryName: string | null }) {
      super("batch already received with a different laboratory");
      this.batchCode = params.batchCode;
      this.existingLaboratoryName = params.existingLaboratoryName;
    }
  },
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/auth/require-role", () => ({ requireCapability }));
vi.mock("@/server/services/inventory-entry.service", () => ({
  registerInventoryEntry,
  LaboratoryEvidenceConflictError,
  LaboratoryNameResolutionError,
  ProductIdentityRequiredError,
  ProductNotFoundError,
  ProductVersionConflictError,
}));
vi.mock("@/server/services/audit.service", () => ({
  recordAudit,
  auditContextFromHeaders,
}));

import { createInventoryEntryAction } from "./entry.actions";

const PREV = { error: null, ok: false };
/** Lo que la FILA dice, que no es lo mismo que lo que mandó el formulario. */
const PRODUCTO = {
  id: "prod-1",
  name: "Amoxicilina",
  orionCode: "ORN-REAL",
  unit: "frasco",
  identityVersion: 3,
  catalogVersion: 7,
};
const session = { user: { id: "u1", email: "b@x.com", name: "Bodega", role: "BODEGA" } };

function formData(overrides: Record<string, string> = {}) {
  const data = new FormData();
  const fields: Record<string, string> = {
    productId: "prod-1",
    quantity: "10",
    batchCode: "LOTE-001",
    expiresAt: "2027-01-01T10:00",
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
    expectedIdentityVersion: "3",
    expectedCatalogVersion: "7",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireCapability.mockResolvedValue(session);
  auditContextFromHeaders.mockResolvedValue({});
  registerInventoryEntry.mockResolvedValue({
    entry: { id: "entry-1" },
    allocatedMissingCount: 0,
    idempotent: false,
    product: PRODUCTO,
  });
});

describe("createInventoryEntryAction · guard", () => {
  it("exige canCreateEntries antes de tocar nada", async () => {
    await createInventoryEntryAction(PREV, formData());

    expect(requireCapability).toHaveBeenCalledWith("canCreateEntries");
  });

  it("no registra la entrada si el guard corta", async () => {
    requireCapability.mockRejectedValue(new Error("redirect"));

    await expect(createInventoryEntryAction(PREV, formData())).rejects.toThrow("redirect");
    expect(registerInventoryEntry).not.toHaveBeenCalled();
  });
});

describe("createInventoryEntryAction · laboratorio recibido", () => {
  it("pasa el id del laboratorio elegido sin resolver nada", async () => {
    const result = await createInventoryEntryAction(
      PREV,
      formData({ receivedLaboratoryId: "lab-mk" }),
    );

    // Elegir de la lista es más específico que escribir el nombre: el id viaja
    // tal cual y el servicio no tiene nada que resolver.
    expect(registerInventoryEntry).toHaveBeenCalledWith(
      expect.objectContaining({ receivedLaboratoryId: "lab-mk" }),
    );
    expect(result.ok).toBe(true);
  });

  // Bodega escribe el nombre y manda; no tiene por qué saber que existe un
  // catálogo de laboratorios detrás. El nombre viaja CRUDO: la action no lo
  // resuelve, y por eso una entrada rechazada no deja laboratorios huérfanos.
  it("pasa el NOMBRE crudo al servicio, sin resolverlo", async () => {
    await createInventoryEntryAction(PREV, formData({ receivedLaboratoryName: "Genfar" }));

    expect(registerInventoryEntry).toHaveBeenCalledWith(
      expect.objectContaining({ receivedLaboratoryName: "Genfar" }),
    );
  });

  it("registra la entrada sin laboratorio cuando no se informó ninguno", async () => {
    await createInventoryEntryAction(PREV, formData());

    expect(registerInventoryEntry).toHaveBeenCalledWith(
      expect.not.objectContaining({ receivedLaboratoryId: expect.anything() }),
    );
  });

  // El servicio devuelve este error cuando el nombre resolvió a OTRO
  // laboratorio. La action no puede seguir: adjuntarlo sería inventar la
  // evidencia del lote.
  it("traduce el nombre que no resolvió, nombrando lo que la persona escribió", async () => {
    registerInventoryEntry.mockRejectedValue(
      new LaboratoryNameResolutionError("Genfar"),
    );

    const result = await createInventoryEntryAction(
      PREV,
      formData({ receivedLaboratoryName: "Genfar" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Genfar");
    expect(result.error).toMatch(/lista/i);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("createInventoryEntryAction · conflicto de evidencia", () => {
  beforeEach(() => {
    registerInventoryEntry.mockRejectedValue(
      new LaboratoryEvidenceConflictError({
        batchCode: "LOTE-001",
        existingLaboratoryName: "MK",
      }),
    );
  });

  it("nombra el lote y el laboratorio ya recibido", async () => {
    const result = await createInventoryEntryAction(
      PREV,
      formData({ receivedLaboratoryId: "lab-genfar" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("LOTE-001");
    expect(result.error).toContain("MK");
  });

  it("NO expone ids internos en el mensaje", async () => {
    const result = await createInventoryEntryAction(
      PREV,
      formData({ receivedLaboratoryId: "lab-genfar" }),
    );

    expect(result.error).not.toContain("lab-genfar");
    expect(result.error).not.toContain("prod-1");
    expect(result.error).not.toContain("entry-1");
  });

  it("distingue el conflicto del error genérico de registro", async () => {
    const conflict = await createInventoryEntryAction(
      PREV,
      formData({ receivedLaboratoryId: "lab-genfar" }),
    );

    registerInventoryEntry.mockRejectedValue(new Error("db down"));
    const generic = await createInventoryEntryAction(PREV, formData());

    expect(conflict.error).not.toBe(generic.error);
    expect(generic.error).toMatch(/no se pudo registrar/i);
  });

  it("no revalida ninguna ruta cuando rechaza", async () => {
    await createInventoryEntryAction(PREV, formData({ receivedLaboratoryId: "lab-genfar" }));

    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// Sin SKU no entra mercadería.
//
// Cargar stock contra un producto sin identidad crea inventario que después
// nadie puede cuadrar contra Orion: existe acá y no existe allá, y la
// diferencia aparece recién cuando alguien hace el conteo.
// --------------------------------------------------------------------------
describe("createInventoryEntryAction · identidad obligatoria", () => {
  it("nombra el producto y explica qué falta", async () => {
    registerInventoryEntry.mockRejectedValue(
      new ProductIdentityRequiredError({
        productId: "prod-9",
        productName: "Gel Caliente Muscular",
      }),
    );

    const result = await createInventoryEntryAction(PREV, formData());

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Gel Caliente Muscular");
    expect(result.error).toMatch(/SKU \(código de Orión\)/);
  });

  // El mensaje decía "completalo en Productos" y ahí terminaba: bodega quedaba
  // buscando entre tres productos de nombre casi igual, que es justo el error
  // que este rechazo existe para impedir. El servidor ya sabe cuál rechazó, así
  // que lo devuelve para que la pantalla lo enlace en vez de hacerlo buscar.
  it("devuelve el producto a resolver, para que la pantalla lo enlace", async () => {
    registerInventoryEntry.mockRejectedValue(
      new ProductIdentityRequiredError({
        productId: "prod-9",
        productName: "Gel Caliente Muscular",
      }),
    );

    const result = await createInventoryEntryAction(PREV, formData());

    expect(result.resolveSkuForProductId).toBe("prod-9");
  });

  // Va en un campo aparte, no dentro del texto: el id es el destino de un
  // enlace, no algo que alguien deba leer ni transcribir.
  it("no ofrece producto a resolver cuando el rechazo es por otra causa", async () => {
    registerInventoryEntry.mockRejectedValue(new Error("falla cualquiera"));

    const result = await createInventoryEntryAction(PREV, formData());

    expect(result.ok).toBe(false);
    expect(result.resolveSkuForProductId).toBeUndefined();
  });

  // El id interno no le sirve a quien recibe la caja para encontrar el producto.
  it("NO expone el id interno en el mensaje", async () => {
    registerInventoryEntry.mockRejectedValue(
      new ProductIdentityRequiredError({
        productId: "cmtdu5ti8000301qfcb38fz3b",
        productName: "Gel Caliente Muscular",
      }),
    );

    const result = await createInventoryEntryAction(PREV, formData());

    expect(result.error).not.toContain("cmtdu5ti8000301qfcb38fz3b");
  });

  it("no revalida ninguna ruta cuando rechaza", async () => {
    registerInventoryEntry.mockRejectedValue(
      new ProductIdentityRequiredError({ productId: "p", productName: "X" }),
    );

    await createInventoryEntryAction(PREV, formData());

    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("createInventoryEntryAction · la fotografía declarada", () => {
  it("le pasa al servicio las dos versiones que la pantalla mostró", async () => {
    await createInventoryEntryAction(PREV, formData());

    expect(registerInventoryEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedIdentityVersion: 3,
        expectedCatalogVersion: 7,
      }),
    );
  });

  it("rechaza la entrada que no declara ninguna versión", async () => {
    const data = formData();
    data.delete("expectedCatalogVersion");

    const result = await createInventoryEntryAction(PREV, data);

    expect(result.ok).toBe(false);
    expect(registerInventoryEntry).not.toHaveBeenCalled();
  });

  // El SKU y la presentación que viajan son lo que la persona VIO. No deciden
  // nada: el servicio lee los suyos de la fila bajo lock.
  it("NO le pasa al servicio el SKU ni la presentación del cliente", async () => {
    await createInventoryEntryAction(
      PREV,
      formData({ displayedSku: "ORN-INVENTADO", displayedPresentation: "ampolla" }),
    );

    expect(registerInventoryEntry).toHaveBeenCalledWith(
      expect.not.objectContaining({ displayedSku: expect.anything() }),
    );
  });
});

describe("createInventoryEntryAction · el producto cambió en el medio", () => {
  it("traduce el conflicto de identidad nombrando el SKU nuevo", async () => {
    registerInventoryEntry.mockRejectedValue(
      new ProductVersionConflictError("identity", { ...PRODUCTO, orionCode: "ORN-NUEVO" }),
    );

    const result = await createInventoryEntryAction(PREV, formData());

    expect(result.ok).toBe(false);
    expect(result.error).toContain("El SKU");
    expect(result.error).toContain("ORN-NUEVO");
    expect(result.conflict).toMatchObject({ identityVersion: 3, catalogVersion: 7 });
  });

  it("traduce el conflicto de catálogo nombrando la presentación nueva", async () => {
    registerInventoryEntry.mockRejectedValue(
      new ProductVersionConflictError("catalog", { ...PRODUCTO, unit: "caja" }),
    );

    const result = await createInventoryEntryAction(PREV, formData());

    expect(result.error).toContain("caja");
    expect(result.conflict?.presentation).toBe("caja");
  });

  // Un rechazo NO es un éxito a medias: no se audita nada.
  it("un conflicto no escribe auditoría", async () => {
    registerInventoryEntry.mockRejectedValue(
      new ProductVersionConflictError("catalog", PRODUCTO),
    );

    await createInventoryEntryAction(PREV, formData());

    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("distingue el producto que ya no existe", async () => {
    registerInventoryEntry.mockRejectedValue(new ProductNotFoundError("prod-1"));

    const result = await createInventoryEntryAction(PREV, formData());

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ya no está disponible");
  });
});

describe("createInventoryEntryAction · auditoría", () => {
  it("registra el SKU, la presentación y las versiones AUTORITATIVAS", async () => {
    await createInventoryEntryAction(
      PREV,
      formData({ displayedSku: "ORN-VIEJO", displayedPresentation: "sobre" }),
    );

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({
          sku: "ORN-REAL",
          presentation: "frasco",
          identityVersion: 3,
          catalogVersion: 7,
          // Y lo que la persona tenía delante, que es otra pregunta.
          displayedSku: "ORN-VIEJO",
          displayedPresentation: "sobre",
        }),
      }),
    );
  });

  // Una segunda fila de ENTRY_CREATE afirmaría dos creaciones del mismo
  // registro, y quien cuadre el inventario contaría dos veces una caja que
  // entró una sola.
  it("un reintento idempotente NO vuelve a auditar", async () => {
    registerInventoryEntry.mockResolvedValue({
      entry: { id: "entry-1" },
      allocatedMissingCount: 0,
      idempotent: true,
    });

    const result = await createInventoryEntryAction(PREV, formData());

    expect(result.ok).toBe(true);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

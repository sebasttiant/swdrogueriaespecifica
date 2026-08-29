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
}));
vi.mock("@/server/services/audit.service", () => ({
  recordAudit,
  auditContextFromHeaders,
}));

import { createInventoryEntryAction } from "./entry.actions";

const PREV = { error: null, ok: false };
const session = { user: { id: "u1", email: "b@x.com", name: "Bodega", role: "BODEGA" } };

function formData(overrides: Record<string, string> = {}) {
  const data = new FormData();
  const fields: Record<string, string> = {
    productId: "prod-1",
    quantity: "10",
    batchCode: "LOTE-001",
    expiresAt: "2027-01-01T10:00",
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
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
  it("nombra el producto y dice dónde resolverlo", async () => {
    registerInventoryEntry.mockRejectedValue(
      new ProductIdentityRequiredError({
        productId: "prod-9",
        productName: "Gel Caliente Muscular",
      }),
    );

    const result = await createInventoryEntryAction(PREV, formData());

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Gel Caliente Muscular");
    expect(result.error).toMatch(/SKU \(código de Orion\)/);
    expect(result.error).toMatch(/Productos/);
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

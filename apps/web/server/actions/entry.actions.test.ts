import { beforeEach, describe, expect, it, vi } from "vitest";

// Aislamos la action: acá se prueba el BORDE —guard, resolución del laboratorio
// y traducción del rechazo a algo que una persona pueda leer—, no la
// transacción, que ya tiene sus propios tests en el service.
// La clase vive DENTRO de `vi.hoisted` porque `vi.mock` se eleva por encima de
// todo el módulo: declarada afuera, la fábrica del mock la leería antes de que
// exista.
const {
  requireCapability,
  registerInventoryEntry,
  findOrCreateLaboratory,
  recordAudit,
  auditContextFromHeaders,
  revalidatePath,
  LaboratoryEvidenceConflictError,
} = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  registerInventoryEntry: vi.fn(),
  findOrCreateLaboratory: vi.fn(),
  recordAudit: vi.fn(),
  auditContextFromHeaders: vi.fn(),
  revalidatePath: vi.fn(),
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
}));
vi.mock("@/server/repositories/laboratory.repository", () => ({ findOrCreateLaboratory }));
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

    expect(findOrCreateLaboratory).not.toHaveBeenCalled();
    expect(registerInventoryEntry).toHaveBeenCalledWith(
      expect.objectContaining({ receivedLaboratoryId: "lab-mk" }),
    );
    expect(result.ok).toBe(true);
  });

  // Bodega escribe el nombre y manda; no tiene por qué saber que existe un
  // catálogo de laboratorios detrás.
  it("resuelve el laboratorio por NOMBRE cuando no vino el id", async () => {
    findOrCreateLaboratory.mockResolvedValue({ laboratory: { id: "lab-nuevo" } });

    await createInventoryEntryAction(PREV, formData({ receivedLaboratoryName: "Genfar" }));

    expect(findOrCreateLaboratory).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Genfar" }),
    );
    expect(registerInventoryEntry).toHaveBeenCalledWith(
      expect.objectContaining({ receivedLaboratoryId: "lab-nuevo" }),
    );
  });

  it("registra la entrada sin laboratorio cuando no se informó ninguno", async () => {
    await createInventoryEntryAction(PREV, formData());

    expect(findOrCreateLaboratory).not.toHaveBeenCalled();
    expect(registerInventoryEntry).toHaveBeenCalledWith(
      expect.not.objectContaining({ receivedLaboratoryId: expect.anything() }),
    );
  });

  it("avisa sin registrar nada si el laboratorio no se pudo resolver", async () => {
    findOrCreateLaboratory.mockRejectedValue(new Error("db down"));

    const result = await createInventoryEntryAction(
      PREV,
      formData({ receivedLaboratoryName: "Genfar" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/laboratorio/i);
    expect(registerInventoryEntry).not.toHaveBeenCalled();
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

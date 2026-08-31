import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireCapability, editProduct, recordAudit, auditContextFromHeaders, revalidatePath } =
  vi.hoisted(() => ({
    requireCapability: vi.fn(),
    editProduct: vi.fn(),
    recordAudit: vi.fn(),
    auditContextFromHeaders: vi.fn(),
    revalidatePath: vi.fn(),
  }));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/auth/require-role", () => ({ requireCapability }));
vi.mock("@/server/services/product.service", () => ({ addProduct: vi.fn(), editProduct }));
vi.mock("@/server/services/audit.service", () => ({ recordAudit, auditContextFromHeaders }));
vi.mock("@/server/repositories/sku-review.repository", () => ({ findProductByIdentity: vi.fn() }));

import { AUDIT_ACTIONS } from "@/lib/constants/audit";

import { updateProductAction } from "./product.actions";

// --------------------------------------------------------------------------
// La Server Action de edición de catálogo.
//
// Lo que se fija acá es la autorización y la auditoría. Que la pantalla
// esconda el botón es cortesía, no autorización: una Server Action es una URL
// y quien la conozca la puede llamar sin pasar nunca por la pantalla.
// --------------------------------------------------------------------------

const ANTES = {
  id: "prod-1",
  code: "MED-001",
  name: "Dolex Niños",
  unit: "unidad",
  minStock: 0,
  reorderQty: 0,
  laboratoryId: null,
  active: true,
};

function formData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  const base: Record<string, string> = {
    id: "prod-1",
    code: "MED-001",
    name: "Dolex Niños",
    unit: "Frasco",
    minStock: "5",
    reorderQty: "20",
    active: "on",
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireCapability.mockResolvedValue({ user: { id: "user-1", role: "BODEGA" } });
  auditContextFromHeaders.mockResolvedValue({ actorId: "user-1" });
  editProduct.mockResolvedValue({ before: ANTES, after: { ...ANTES, unit: "Frasco" } });
});

describe("updateProductAction · autorización", () => {
  it("exige canManageProducts en el SERVIDOR", async () => {
    await updateProductAction({ error: null, ok: false }, formData());

    expect(requireCapability).toHaveBeenCalledWith("canManageProducts");
  });

  // `requireCapability` corta antes de tocar nada: sin permiso no se edita ni
  // se audita.
  it("sin permiso no edita ni audita", async () => {
    requireCapability.mockRejectedValue(new Error("forbidden"));

    await expect(
      updateProductAction({ error: null, ok: false }, formData()),
    ).rejects.toThrow();

    expect(editProduct).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("updateProductAction · lo que deja pasar al servicio", () => {
  it("manda solo los campos de catálogo", async () => {
    await updateProductAction({ error: null, ok: false }, formData());

    const [id, data] = editProduct.mock.calls[0]!;
    expect(id).toBe("prod-1");
    expect(Object.keys(data).sort()).toEqual(
      ["active", "code", "laboratoryId", "minStock", "name", "reorderQty", "unit"].sort(),
    );
  });

  // El intento que esta acción tiene que frenar: alguien llamándola a mano con
  // un stock adentro. El esquema lo descarta antes de llegar al servicio.
  it("descarta cantidades aunque las manden en el FormData", async () => {
    await updateProductAction(
      { error: null, ok: false },
      formData({ stock: "999", quantity: "999", onHand: "999" }),
    );

    const [, data] = editProduct.mock.calls[0]!;
    expect(data).not.toHaveProperty("stock");
    expect(data).not.toHaveProperty("quantity");
    expect(data).not.toHaveProperty("onHand");
  });

  it("descarta el SKU aunque lo manden: tiene su propio circuito", async () => {
    await updateProductAction(
      { error: null, ok: false },
      formData({ orionCode: "ORN-999", identityVersion: "7" }),
    );

    const [, data] = editProduct.mock.calls[0]!;
    expect(data).not.toHaveProperty("orionCode");
    expect(data).not.toHaveProperty("identityVersion");
  });
});

describe("updateProductAction · auditoría", () => {
  // "El laboratorio ahora es Genfar" no explica nada; "era Bayer y ahora es
  // Genfar" es lo que permite entender una decisión seis meses después.
  it("registra el ANTES y el DESPUÉS, no solo cómo quedó", async () => {
    await updateProductAction({ error: null, ok: false }, formData());

    const registro = recordAudit.mock.calls[0]![0];
    expect(registro.action).toBe(AUDIT_ACTIONS.PRODUCT_UPDATE);
    expect(registro.entityId).toBe("prod-1");
    expect(registro.before).toMatchObject({ unit: "unidad", name: "Dolex Niños" });
    expect(registro.after).toMatchObject({ unit: "Frasco" });
  });

  it("no audita si el producto ya no existe", async () => {
    editProduct.mockResolvedValue(null);

    const state = await updateProductAction({ error: null, ok: false }, formData());

    expect(state.ok).toBe(false);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("updateProductAction · errores accionables", () => {
  it("rechaza datos inválidos sin tocar el producto", async () => {
    const state = await updateProductAction(
      { error: null, ok: false },
      formData({ name: "" }),
    );

    expect(state.ok).toBe(false);
    expect(state.error).toBeTruthy();
    expect(editProduct).not.toHaveBeenCalled();
  });

  it("refresca las dos pantallas que muestran el producto", async () => {
    await updateProductAction({ error: null, ok: false }, formData());

    expect(revalidatePath).toHaveBeenCalledWith("/productos");
    expect(revalidatePath).toHaveBeenCalledWith("/productos/prod-1");
  });
});

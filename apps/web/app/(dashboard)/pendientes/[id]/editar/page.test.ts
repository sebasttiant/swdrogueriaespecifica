import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  getPendingForEdit: vi.fn(),
  notFound: vi.fn(),
  formProps: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/auth/require-role", () => ({ requireCapability: mocks.requireCapability }));
vi.mock("@/server/services/pending.service", () => ({
  getPendingForEdit: mocks.getPendingForEdit,
  getUsedZones: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/server/services/product.service", () => ({
  getProducts: vi.fn().mockResolvedValue({ items: [] }),
}));
vi.mock("@/app/_components/app-shell/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/features/pendientes/pending-edit-form", () => ({
  PendingEditForm: (props: unknown) => {
    mocks.formProps(props);
    return null;
  },
}));

import { renderToStaticMarkup } from "react-dom/server";

import EditarPendientePage from "./page";

const PENDING = {
  id: "pend-1",
  productId: "prod-1",
  quantity: 2,
  status: "PENDIENTE",
  createdById: "otro",
  deliveredQuantity: 0,
  invoicedQuantity: 0,
  sellerEditedAt: new Date("2026-07-01T10:00:00.000Z"),
  customerName: null,
  customerPhone: null,
  customerAddress: null,
  note: null,
  manualSellerName: null,
  zone: null,
  totalAmount: null,
  paidAmount: 0,
  paymentMethod: null,
  promisedAt: new Date("2026-08-01T10:00:00.000Z"),
  updatedAt: new Date("2026-07-09T11:00:00.123Z"),
};

async function render() {
  return renderToStaticMarkup(
    await EditarPendientePage({ params: Promise.resolve({ id: "pend-1" }) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
});

// --------------------------------------------------------------------------
// La pantalla de corrección (gerencia, 2026-09-30): el alcance lo decide el
// service con la sesión, y la pantalla pasa al formulario si es restringida.
// --------------------------------------------------------------------------
describe("EditarPendientePage", () => {
  it("le pasa al service quién corrige, desde la sesión", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "bod-1", role: "BODEGA" } });
    mocks.getPendingForEdit.mockResolvedValue({ pending: PENDING, restricted: true });

    await render();

    expect(mocks.requireCapability).toHaveBeenCalledWith("canCreatePendientes");
    expect(mocks.getPendingForEdit).toHaveBeenCalledWith({
      id: "pend-1",
      actor: { role: "BODEGA", userId: "bod-1" },
    });
  });

  it("fila ajena: formulario restringido, sin aviso de corrección única aunque ya se haya corregido", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "op-1", role: "OPERADOR" } });
    mocks.getPendingForEdit.mockResolvedValue({ pending: PENDING, restricted: true });

    await render();

    expect(mocks.formProps).toHaveBeenCalledWith(
      expect.objectContaining({ restricted: true, productLocked: false, isLastChance: false }),
    );
  });

  it("fila ajena: las props del formulario no llevan identidad, montos ni vendedor escrito", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "op-1", role: "OPERADOR" } });
    const {
      customerName: _a,
      customerPhone: _b,
      customerAddress: _c,
      totalAmount: _d,
      paidAmount: _e,
      paymentMethod: _f,
      manualSellerName: _g,
      ...operational
    } = PENDING;
    mocks.getPendingForEdit.mockResolvedValue({ pending: operational, restricted: true });

    await render();

    const { pending } = mocks.formProps.mock.calls[0]![0] as { pending: Record<string, unknown> };
    for (const field of [
      "customerName",
      "customerPhone",
      "customerAddress",
      "totalAmount",
      "paidAmount",
      "paymentMethod",
      "manualSellerName",
    ]) {
      expect(pending).not.toHaveProperty(field);
    }
    expect(pending.updatedAt).toEqual(PENDING.updatedAt);
  });

  it("fila ajena con algo facturado: producto bloqueado", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "op-1", role: "OPERADOR" } });
    mocks.getPendingForEdit.mockResolvedValue({
      pending: { ...PENDING, invoicedQuantity: 1 },
      restricted: true,
    });

    await render();

    expect(mocks.formProps).toHaveBeenCalledWith(
      expect.objectContaining({ restricted: true, productLocked: true }),
    );
  });

  it("gerencia sobre una fila facturada: completa y sin bloqueo (hallazgo aparte, no se toca)", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "adm-1", role: "ADMIN" } });
    mocks.getPendingForEdit.mockResolvedValue({
      pending: { ...PENDING, invoicedQuantity: 1 },
      restricted: false,
    });

    await render();

    expect(mocks.formProps).toHaveBeenCalledWith(
      expect.objectContaining({ restricted: false, productLocked: false }),
    );
  });

  // Contención T9: el dueño sin autoridad de compras ve el producto bloqueado
  // si el pendiente ya tiene mercadería apartada. ADMIN (compras) no.
  it.each([
    ["OPERADOR", "op-1", true],
    ["BODEGA", "op-1", true],
    ["SUPERVISOR", "op-1", true],
    ["ADMIN", "op-1", false],
  ] as const)("%s dueño (usuario %s) con mercadería apartada: producto bloqueado=%s", async (role, id, locked) => {
    mocks.requireCapability.mockResolvedValue({ user: { id, role } });
    mocks.getPendingForEdit.mockResolvedValue({
      pending: { ...PENDING, createdById: "op-1" },
      restricted: false,
      stockSetAside: true,
    });

    await render();

    expect(mocks.formProps).toHaveBeenCalledWith(
      expect.objectContaining({
        restricted: false,
        productLocked: locked,
        ...(locked ? { productLockReason: "stockSetAside" } : {}),
      }),
    );
  });

  it("OPERADOR dueño sin mercadería apartada: producto libre", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "op-1", role: "OPERADOR" } });
    mocks.getPendingForEdit.mockResolvedValue({
      pending: { ...PENDING, createdById: "op-1" },
      restricted: false,
      stockSetAside: false,
    });

    await render();

    expect(mocks.formProps).toHaveBeenCalledWith(expect.objectContaining({ productLocked: false }));
  });

  it("sin alcance, el mismo 404 que si no existiera", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "op-1", role: "OPERADOR" } });
    mocks.getPendingForEdit.mockResolvedValue(null);

    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.formProps).not.toHaveBeenCalled();
  });
});

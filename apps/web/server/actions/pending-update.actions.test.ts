import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditContextFromHeaders: vi.fn(),
  recordAudit: vi.fn(),
  requireCapability: vi.fn(),
  checkCapability: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
  updatePending: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth/require-role", () => ({
  requireCapability: mocks.requireCapability,
  checkCapability: mocks.checkCapability,
}));
vi.mock("@/server/services/audit.service", () => ({
  auditContextFromHeaders: mocks.auditContextFromHeaders,
  recordAudit: mocks.recordAudit,
}));
vi.mock("@/server/services/pending.service", () => ({
  updatePending: mocks.updatePending,
  ManualProductIdentityConflictError: class extends Error {},
  PendingIdempotencyPayloadConflictError: class extends Error {},
}));
vi.mock("@/server/services/sku-onboarding.service", () => ({
  linkOrionCodeAtCapture: vi.fn(),
  linkOrionCode: vi.fn(),
}));
vi.mock("@/server/repositories/product.repository", () => ({ findProductById: vi.fn() }));
vi.mock("@/server/repositories/laboratory.repository", () => ({ findOrCreateLaboratory: vi.fn() }));
vi.mock("@/server/repositories/sku-review.repository", () => ({
  SkuConcurrencyError: class extends Error {},
}));

import { AUDIT_ACTIONS } from "@/lib/constants/audit";
import { updatePendingAction } from "./pending.actions";

// --------------------------------------------------------------------------
// Corregir un pendiente desde la Server Action (gerencia, 2026-09-30).
//
// La acción no sabe de quién es la fila: eso se decide bajo el lock, en el
// service. Lo que sí hace es decir qué llegó —campos protegidos presentes o
// no, y el testigo de concurrencia—, pasar la autoridad del rol, y auditar
// cada rechazo de autoridad, estado o concurrencia con el actor REAL de la
// sesión. Los errores comunes de validación no se auditan, igual que antes.
// --------------------------------------------------------------------------

const PREV = { error: null, ok: false };
const LOADED_AT = "2026-07-09T11:00:00.123Z";

function sesion(role: string, id: string) {
  return { user: { id, role, email: `${id}@x.test` } };
}

// Lo que manda el formulario RESTRINGIDO (fila ajena): sin identidad ni montos.
function restrictedForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("id", "pend-1");
  data.set("productId", "prod-1");
  data.set("quantity", "3");
  data.set("promisedAt", "2099-01-02T12:00");
  data.set("zone", "Belén");
  data.set("note", "cambió la fecha");
  data.set("expectedUpdatedAt", LOADED_AT);
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

// Lo que manda el formulario COMPLETO (propio o gerencia).
function fullForm(overrides: Record<string, string> = {}) {
  const data = restrictedForm();
  data.set("customerName", "Ana Pérez");
  data.set("customerPhone", "300 123 4567");
  data.set("customerAddress", "");
  data.set("totalAmount", "");
  data.set("paidAmount", "");
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

const BEFORE = {
  id: "pend-1",
  productId: "prod-1",
  quantity: 2,
  status: "PENDIENTE",
  createdById: "otro",
  deliveredQuantity: 0,
  invoicedQuantity: 0,
  sellerEditedAt: null,
  customerName: "Cliente real",
  customerPhone: "3009998877",
  customerAddress: null,
  note: null,
  manualSellerName: null,
  zone: null,
  totalAmount: 10_000,
  paidAmount: 0,
  paymentMethod: null,
  promisedAt: new Date("2099-01-01T17:00:00.000Z"),
  updatedAt: new Date(LOADED_AT),
};

function auditCalls() {
  return mocks.recordAudit.mock.calls.map(([entry]) => entry as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordAudit.mockResolvedValue({ ok: true });
  mocks.auditContextFromHeaders.mockImplementation(async (userId: string) => ({ userId, channel: "web" }));
  mocks.redirect.mockImplementation(() => {
    throw new Error("NEXT_REDIRECT");
  });
});

describe("updatePendingAction · autoridad y lo que llega al service", () => {
  it.each([
    ["OPERADOR", false, true, false],
    ["BODEGA", false, true, false],
    ["SUPERVISOR", true, true, false],
    ["ADMIN", true, true, true],
    ["SUPERADMIN", true, true, true],
  ] as const)("%s: canManageAll=%s, canEditAll=%s, canOrder=%s", async (role, canManageAll, canEditAll, canOrder) => {
    mocks.requireCapability.mockResolvedValue(sesion(role, "actor-1"));
    mocks.updatePending.mockResolvedValue({ rejection: "STALE", before: null });

    await updatePendingAction(PREV, restrictedForm());

    expect(mocks.requireCapability).toHaveBeenCalledWith("canCreatePendientes");
    expect(mocks.updatePending).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "actor-1", canManageAll, canEditAll, canOrder }),
    );
  });

  it("el formulario restringido llega sin campos protegidos y con el testigo", async () => {
    mocks.requireCapability.mockResolvedValue(sesion("BODEGA", "bod-1"));
    mocks.updatePending.mockResolvedValue({ rejection: "STALE", before: null });

    await updatePendingAction(PREV, restrictedForm());

    const input = mocks.updatePending.mock.calls[0]![0];
    expect(input.protectedFields).toEqual({ state: "absent" });
    expect(input.expectedUpdatedAt).toEqual(new Date(LOADED_AT));
    expect(input.zone).toBe("Belén");
    expect(input.note).toBe("cambió la fecha");
  });

  it("un campo protegido presente, aunque venga vacío, se informa como presente", async () => {
    mocks.requireCapability.mockResolvedValue(sesion("OPERADOR", "op-1"));
    mocks.updatePending.mockResolvedValue({ rejection: "INVALID_REQUEST", before: null });

    await updatePendingAction(PREV, restrictedForm({ totalAmount: "" }));

    expect(mocks.updatePending.mock.calls[0]![0].protectedFields.state).not.toBe("absent");
  });

  it.each([
    ["ausente", undefined, false],
    ["vacío", "", true],
    ["con texto", "Carlos", true],
  ] as const)("vendedor escrito %s: se informa su presencia al service", async (_l, value, sent) => {
    mocks.requireCapability.mockResolvedValue(sesion("BODEGA", "bod-1"));
    mocks.updatePending.mockResolvedValue({ rejection: "STALE", before: null });
    const form = restrictedForm();
    if (value !== undefined) form.set("manualSellerName", value);

    await updatePendingAction(PREV, form);

    expect(mocks.updatePending.mock.calls[0]![0].manualSellerNameSent).toBe(sent);
  });

  it("el formulario completo llega con los campos protegidos validados", async () => {
    mocks.requireCapability.mockResolvedValue(sesion("OPERADOR", "op-1"));
    mocks.updatePending.mockResolvedValue({ rejection: "STALE", before: null });

    await updatePendingAction(PREV, fullForm());

    expect(mocks.updatePending.mock.calls[0]![0].protectedFields).toEqual({
      state: "valid",
      values: expect.objectContaining({ customerName: "Ana Pérez", customerPhone: "3001234567" }),
    });
  });

  it("abono mayor al total es un dato inválido, no se pierde la validación", async () => {
    mocks.requireCapability.mockResolvedValue(sesion("ADMIN", "adm-1"));
    mocks.updatePending.mockResolvedValue({ rejection: "INVALID_DATA", before: null });

    await updatePendingAction(PREV, fullForm({ totalAmount: "10000", paidAmount: "20000" }));

    expect(mocks.updatePending.mock.calls[0]![0].protectedFields).toEqual({ state: "invalid" });
  });

  it.each([
    ["ausente", undefined],
    ["ilegible", "ayer a la tarde"],
  ])("testigo %s llega como null al service", async (_label, value) => {
    mocks.requireCapability.mockResolvedValue(sesion("ADMIN", "adm-1"));
    mocks.updatePending.mockResolvedValue({ rejection: "INVALID_REQUEST", before: null });
    const form = fullForm();
    if (value === undefined) form.delete("expectedUpdatedAt");
    else form.set("expectedUpdatedAt", value);

    await updatePendingAction(PREV, form);

    expect(mocks.updatePending.mock.calls[0]![0].expectedUpdatedAt).toBeNull();
  });
});

describe("updatePendingAction · rechazos auditados", () => {
  it.each([
    [
      "INVALID_REQUEST",
      "campo no permitido en esta corrección",
      "La solicitud no es válida. Recargá la página e intentá de nuevo.",
    ],
    [
      "STALE",
      undefined,
      "Otra persona modificó este pendiente desde que abriste el formulario. Recargá para ver los cambios.",
    ],
    [
      "PRODUCT_LOCKED",
      undefined,
      "No se puede cambiar el producto: este pendiente ya tiene unidades facturadas o entregadas.",
    ],
    [
      "PRODUCT_LOCKED_SUPPLY",
      undefined,
      "No podés cambiar el producto: ya hay stock reservado o una compra en curso para este pendiente. Pedile el cambio a supervisión.",
    ],
    [
      "PRODUCT_LOCKED_STOCK",
      undefined,
      "No podés cambiar el producto: este pendiente ya tiene mercadería apartada. Pedile el cambio a gerencia.",
    ],
    ["NOT_OWNER", undefined, "Solo podés corregir un pendiente que hayas creado vos."],
    ["ALREADY_CLOSED", undefined, "Este pendiente ya está cerrado y no se puede corregir."],
  ] as const)("%s se audita como FAILURE con el actor real", async (rejection, detail, message) => {
    mocks.requireCapability.mockResolvedValue(sesion("BODEGA", "bod-1"));
    mocks.updatePending.mockResolvedValue({ rejection, before: null, detail });

    const result = await updatePendingAction(PREV, restrictedForm());

    expect(result).toEqual(expect.objectContaining({ ok: false, error: message }));
    const [entry] = auditCalls();
    expect(entry).toEqual(
      expect.objectContaining({
        action: AUDIT_ACTIONS.PENDING_UPDATE,
        entityId: "pend-1",
        result: "FAILURE",
        after: detail ? { reason: rejection, detail } : { reason: rejection },
        context: expect.objectContaining({ userId: "bod-1" }),
      }),
    );
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("un dato mal escrito es un error de formulario, como antes", async () => {
    mocks.requireCapability.mockResolvedValue(sesion("ADMIN", "adm-1"));
    mocks.updatePending.mockResolvedValue({ rejection: "INVALID_DATA", before: null });

    const result = await updatePendingAction(PREV, fullForm());

    expect(result).toEqual(
      expect.objectContaining({ ok: false, error: "Revisá los datos del pendiente." }),
    );
  });
});

describe("updatePendingAction · guardar sin cambios", () => {
  it("no audita, no revalida y avisa que no había cambios", async () => {
    mocks.requireCapability.mockResolvedValue(sesion("OPERADOR", "op-1"));
    mocks.updatePending.mockResolvedValue({
      rejection: null,
      before: BEFORE,
      outcome: "UNCHANGED",
      restricted: true,
    });

    const result = await updatePendingAction(PREV, restrictedForm());

    expect(result).toEqual({ error: null, ok: true, unchanged: true });
    expect(mocks.recordAudit).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("updatePendingAction · corrección guardada", () => {
  it("la restringida audita solo los campos operativos, con el actor real", async () => {
    mocks.requireCapability.mockResolvedValue(sesion("BODEGA", "bod-1"));
    mocks.updatePending.mockResolvedValue({
      rejection: null,
      before: BEFORE,
      outcome: "UPDATED",
      restricted: true,
    });

    await expect(updatePendingAction(PREV, restrictedForm())).rejects.toThrow("NEXT_REDIRECT");

    const [entry] = auditCalls();
    expect(entry).toEqual(
      expect.objectContaining({
        action: AUDIT_ACTIONS.PENDING_UPDATE,
        result: "SUCCESS",
        context: expect.objectContaining({ userId: "bod-1" }),
      }),
    );
    const after = (entry!.after as { after: Record<string, unknown> }).after;
    const before = (entry!.after as { before: Record<string, unknown> }).before;
    expect(Object.keys(after).sort()).toEqual(["note", "productId", "promisedAt", "quantity", "zone"]);
    expect(Object.keys(before).sort()).toEqual(["note", "productId", "promisedAt", "quantity", "zone"]);
    expect(JSON.stringify(entry!.after)).not.toContain("Cliente real");
    expect(mocks.redirect).toHaveBeenCalledWith("/pendientes");
  });

  it("la completa audita antes y después con todos los campos", async () => {
    mocks.requireCapability.mockResolvedValue(sesion("ADMIN", "adm-1"));
    mocks.updatePending.mockResolvedValue({
      rejection: null,
      before: BEFORE,
      outcome: "UPDATED",
      restricted: false,
    });

    await expect(updatePendingAction(PREV, fullForm())).rejects.toThrow("NEXT_REDIRECT");

    const after = (auditCalls()[0]!.after as { after: Record<string, unknown> }).after;
    expect(after).toEqual(
      expect.objectContaining({ customerName: "Ana Pérez", customerPhone: "3001234567", quantity: 3 }),
    );
  });
});

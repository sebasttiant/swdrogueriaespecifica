import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditContextFromHeaders: vi.fn(),
  confirmMissingItemOk: vi.fn(),
  recordAudit: vi.fn(),
  requireCapability: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/require-role", () => ({ requireCapability: mocks.requireCapability }));
vi.mock("@/server/services/audit.service", () => ({
  auditContextFromHeaders: mocks.auditContextFromHeaders,
  recordAudit: mocks.recordAudit,
}));
vi.mock("@/server/services/missing-item.service", () => ({
  confirmMissingItemOk: mocks.confirmMissingItemOk,
}));

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { confirmMissingItemAction } from "./missing-item.actions";

const PREV = { error: null, ok: false };

function formData() {
  const data = new FormData();
  data.set("id", "missing-1");
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auditContextFromHeaders.mockResolvedValue({ userId: "admin-1", channel: "web" });
});

describe("confirmMissingItemAction", () => {
  it("guards with the canConfirmMissingItems capability and rejects before mutation", async () => {
    mocks.requireCapability.mockRejectedValueOnce(new Error("REDIRECT:/dashboard"));

    await expect(confirmMissingItemAction(PREV, formData())).rejects.toThrow(
      "REDIRECT:/dashboard",
    );
    expect(mocks.requireCapability).toHaveBeenCalledWith("canConfirmMissingItems");
    expect(mocks.confirmMissingItemOk).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("confirms, audits management OK, and revalidates active views", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mocks.confirmMissingItemOk.mockResolvedValue({
      changed: true,
      item: { id: "missing-1", status: "PEDIDO", confirmedAt: new Date() },
    });

    await expect(confirmMissingItemAction(PREV, formData())).resolves.toEqual({ error: null, ok: true });
    expect(mocks.confirmMissingItemOk).toHaveBeenCalledWith(
      expect.objectContaining({ id: "missing-1", confirmedById: "admin-1" }),
    );
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTIONS.MISSING_CONFIRM_OK,
        module: AUDIT_MODULES.FALTANTES,
        entityId: "missing-1",
        after: { status: "PEDIDO", changed: true },
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/faltantes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("allows SUPERVISOR through the same capability boundary", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "sup-1", role: "SUPERVISOR" } });
    mocks.confirmMissingItemOk.mockResolvedValue({
      changed: true,
      item: { id: "missing-1", status: "PEDIDO", confirmedAt: new Date() },
    });

    await expect(confirmMissingItemAction(PREV, formData())).resolves.toEqual({ error: null, ok: true });
    expect(mocks.requireCapability).toHaveBeenCalledWith("canConfirmMissingItems");
    expect(mocks.confirmMissingItemOk).toHaveBeenCalledWith(
      expect.objectContaining({ id: "missing-1", confirmedById: "sup-1" }),
    );
  });
});

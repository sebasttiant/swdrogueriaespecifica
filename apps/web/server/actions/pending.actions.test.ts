import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditContextFromHeaders: vi.fn(),
  cancelPendingCommitment: vi.fn(),
  deliverPending: vi.fn(),
  recordAudit: vi.fn(),
  registerPending: vi.fn(),
  requireCapability: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/require-role", () => ({ requireCapability: mocks.requireCapability }));
vi.mock("@/server/services/audit.service", () => ({
  auditContextFromHeaders: mocks.auditContextFromHeaders,
  recordAudit: mocks.recordAudit,
}));
vi.mock("@/server/services/pending.service", () => ({
  cancelPendingCommitment: mocks.cancelPendingCommitment,
  deliverPending: mocks.deliverPending,
  registerPending: mocks.registerPending,
}));

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { cancelPendingAction, deliverPendingAction } from "./pending.actions";

const PREV = { error: null, ok: false };

function deliverFormData(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("id", "pend-1");
  data.set("quantity", "3");
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

function cancelFormData(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("id", "pend-1");
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auditContextFromHeaders.mockResolvedValue({ userId: "user-1", channel: "web" });
});

describe("deliverPendingAction", () => {
  it("guards with canDeliverPendings and rejects before mutation", async () => {
    mocks.requireCapability.mockRejectedValueOnce(new Error("REDIRECT:/dashboard"));

    await expect(deliverPendingAction(PREV, deliverFormData())).rejects.toThrow(
      "REDIRECT:/dashboard",
    );
    expect(mocks.requireCapability).toHaveBeenCalledWith("canDeliverPendings");
    expect(mocks.deliverPending).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("allows OPERADOR through the capability boundary", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "op-1", role: "OPERADOR" } });
    mocks.deliverPending.mockResolvedValue({
      rejection: null,
      pending: { id: "pend-1", status: "PARCIAL", deliveredQuantity: 3, completedAt: null },
    });

    const result = await deliverPendingAction(PREV, deliverFormData());

    expect(result).toEqual({ error: null, ok: true });
    expect(mocks.requireCapability).toHaveBeenCalledWith("canDeliverPendings");
    expect(mocks.deliverPending).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pend-1", quantity: 3, deliveredById: "op-1" }),
    );
  });

  it("audits the delivery without leaking customerName and revalidates active views", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "sup-1", role: "SUPERVISOR" } });
    mocks.deliverPending.mockResolvedValue({
      rejection: null,
      pending: { id: "pend-1", status: "ENTREGADO", deliveredQuantity: 10, completedAt: new Date() },
    });

    await deliverPendingAction(PREV, deliverFormData({ quantity: "10" }));

    expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
    const auditCall = mocks.recordAudit.mock.calls[0]![0];
    expect(auditCall).toEqual(
      expect.objectContaining({
        action: AUDIT_ACTIONS.PENDING_DELIVERED,
        module: AUDIT_MODULES.PENDIENTES,
        entityId: "pend-1",
      }),
    );
    expect(JSON.stringify(auditCall.after)).not.toContain("customerName");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/pendientes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

	const deliveryRejectionCases = [
		["ALREADY_DELIVERED", "Este pendiente ya fue entregado."],
		["ALREADY_CANCELLED", "Este pendiente está cancelado."],
		["NON_POSITIVE_QUANTITY", "Ingresá una cantidad válida."],
		["EXCEEDS_REMAINING", "La cantidad supera lo que resta por entregar."],
	] as const;

	// Un rechazo de negocio es un intento real contra una invariante: quién quiso
	// entregar qué sobre un pendiente que no lo admitía. Se audita como FAILURE
	// para que quede la traza forense, sin `customerName`.
	it.each(deliveryRejectionCases)(
		"maps %s to the exact Spanish message, audits it as FAILURE, and revalidates",
		async (rejection, error) => {
			mocks.requireCapability.mockResolvedValue({ user: { id: "op-1", role: "OPERADOR" } });
			mocks.deliverPending.mockResolvedValue({ rejection, pending: null });

			const result = await deliverPendingAction(PREV, deliverFormData());

			expect(result).toEqual({ error, ok: false });

			expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
			const auditCall = mocks.recordAudit.mock.calls[0]![0];
			expect(auditCall).toEqual(
				expect.objectContaining({
					action: AUDIT_ACTIONS.PENDING_DELIVERED,
					module: AUDIT_MODULES.PENDIENTES,
					entity: "Pending",
					entityId: "pend-1",
					result: "FAILURE",
					after: { reason: rejection, attemptedQuantity: 3 },
				}),
			);
			expect(JSON.stringify(auditCall)).not.toContain("customerName");

			expect(mocks.revalidatePath).toHaveBeenCalledWith("/pendientes");
			expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
		},
	);

  it("rejects invalid input before calling the service", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "op-1", role: "OPERADOR" } });

    const result = await deliverPendingAction(PREV, deliverFormData({ quantity: "0" }));

    expect(result.ok).toBe(false);
    expect(mocks.deliverPending).not.toHaveBeenCalled();
  });
});

describe("cancelPendingAction", () => {
  it("guards with canCancelPendings and rejects before mutation", async () => {
    mocks.requireCapability.mockRejectedValueOnce(new Error("REDIRECT:/dashboard"));

    await expect(cancelPendingAction(PREV, cancelFormData())).rejects.toThrow(
      "REDIRECT:/dashboard",
    );
    expect(mocks.requireCapability).toHaveBeenCalledWith("canCancelPendings");
    expect(mocks.cancelPendingCommitment).not.toHaveBeenCalled();
  });

  it("rejects OPERADOR via the capability guard (never reaches the service)", async () => {
    mocks.requireCapability.mockRejectedValueOnce(new Error("REDIRECT:/dashboard"));

    await expect(cancelPendingAction(PREV, cancelFormData())).rejects.toThrow();
    expect(mocks.cancelPendingCommitment).not.toHaveBeenCalled();
  });

  it("allows SUPERVISOR to cancel, audits without customerName, and revalidates", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "sup-1", role: "SUPERVISOR" } });
    mocks.cancelPendingCommitment.mockResolvedValue({
      rejection: null,
      pending: { id: "pend-1", status: "CANCELADO", cancelledAt: new Date() },
    });

    const result = await cancelPendingAction(PREV, cancelFormData({ reason: "Cliente desistió" }));

    expect(result).toEqual({ error: null, ok: true });
    expect(mocks.cancelPendingCommitment).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pend-1", cancelledById: "sup-1", reason: "Cliente desistió" }),
    );
    const auditCall = mocks.recordAudit.mock.calls[0]![0];
    expect(auditCall).toEqual(
      expect.objectContaining({
        action: AUDIT_ACTIONS.PENDING_CANCELLED,
        module: AUDIT_MODULES.PENDIENTES,
        entityId: "pend-1",
      }),
    );
    expect(JSON.stringify(auditCall.after)).not.toContain("customerName");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/pendientes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

	const cancelRejectionCases = [
		["ALREADY_DELIVERED", "No se puede cancelar un pendiente ya entregado."],
		["ALREADY_CANCELLED", "Este pendiente ya está cancelado."],
	] as const;

	it.each(cancelRejectionCases)(
		"maps %s to the exact Spanish message, audits it as FAILURE, and revalidates",
		async (rejection, error) => {
			mocks.requireCapability.mockResolvedValue({ user: { id: "sup-1", role: "SUPERVISOR" } });
			mocks.cancelPendingCommitment.mockResolvedValue({ rejection, pending: null });

			const result = await cancelPendingAction(PREV, cancelFormData());

			expect(result).toEqual({ error, ok: false });

			expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
			const auditCall = mocks.recordAudit.mock.calls[0]![0];
			expect(auditCall).toEqual(
				expect.objectContaining({
					action: AUDIT_ACTIONS.PENDING_CANCELLED,
					module: AUDIT_MODULES.PENDIENTES,
					entity: "Pending",
					entityId: "pend-1",
					result: "FAILURE",
					after: { reason: rejection },
				}),
			);
			expect(JSON.stringify(auditCall)).not.toContain("customerName");

			expect(mocks.revalidatePath).toHaveBeenCalledWith("/pendientes");
			expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
		},
	);

	// El motivo de cancelación es texto libre del operador: puede nombrar al
	// cliente. En un rechazo la cancelación no ocurrió, así que el intento se
	// audita con el código de rechazo y nunca con ese texto.
	it("keeps the operator's free-text cancel reason out of the failure audit", async () => {
		mocks.requireCapability.mockResolvedValue({ user: { id: "sup-1", role: "SUPERVISOR" } });
		mocks.cancelPendingCommitment.mockResolvedValue({
			rejection: "ALREADY_DELIVERED",
			pending: null,
		});

		await cancelPendingAction(
			PREV,
			cancelFormData({ reason: "El cliente Juan Pérez ya lo retiró" }),
		);

		const auditCall = mocks.recordAudit.mock.calls[0]![0];
		expect(JSON.stringify(auditCall)).not.toContain("Juan Pérez");
	});
});

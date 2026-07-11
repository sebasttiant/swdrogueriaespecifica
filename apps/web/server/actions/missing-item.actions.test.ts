import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditContextFromHeaders: vi.fn(),
  confirmMissingItemOk: vi.fn(),
  createManualMissingItem: vi.fn(),
  orderMissingItem: vi.fn(),
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
  createManualMissingItem: mocks.createManualMissingItem,
  orderMissingItem: mocks.orderMissingItem,
}));

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  confirmMissingItemAction,
  createMissingItemAction,
  orderMissingItemAction,
} from "./missing-item.actions";

const PREV = { error: null, ok: false };

function formData() {
  const data = new FormData();
  data.set("id", "missing-1");
  return data;
}

// FormData del pedido para la rama "proveedor existente".
function orderExistingFormData(supplierId = "sup-1") {
  const data = new FormData();
  data.set("missingItemId", "missing-1");
  data.set("supplierId", supplierId);
  return data;
}

// FormData del pedido para la rama "proveedor nuevo" (sin `supplierId`).
function orderNewSupplierFormData() {
  const data = new FormData();
  data.set("missingItemId", "missing-1");
  data.set("supplierId", "");
  data.set("name", "Droguería Central");
  data.set("phone", "555");
  return data;
}

function manualMissingFormData() {
  const data = new FormData();
  data.set("productId", "prod-1");
  data.set("quantity", "3");
  data.set("note", "Prioridad mostrador");
  return data;
}

// `requireCapability` keyed por capability: permite modelar que un ADMIN pueda
// pedir (`canOrderMissingItems`) pero NO crear proveedores (`canManageSuppliers`).
function grant(
  role: "SUPERADMIN" | "ADMIN" | "SUPERVISOR" | "OPERADOR",
  allowed: readonly string[],
) {
  mocks.requireCapability.mockImplementation((capability: string) => {
    if (allowed.includes(capability)) {
      return Promise.resolve({ user: { id: `${role.toLowerCase()}-1`, role } });
    }
    return Promise.reject(new Error("REDIRECT:/dashboard"));
  });
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
      item: { id: "missing-1", status: "FALTANTE", confirmedAt: new Date() },
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
        after: { status: "FALTANTE", changed: true },
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/faltantes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("allows SUPERVISOR through the same capability boundary", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "sup-1", role: "SUPERVISOR" } });
    mocks.confirmMissingItemOk.mockResolvedValue({
      changed: true,
      item: { id: "missing-1", status: "FALTANTE", confirmedAt: new Date() },
    });

    await expect(confirmMissingItemAction(PREV, formData())).resolves.toEqual({ error: null, ok: true });
    expect(mocks.requireCapability).toHaveBeenCalledWith("canConfirmMissingItems");
    expect(mocks.confirmMissingItemOk).toHaveBeenCalledWith(
      expect.objectContaining({ id: "missing-1", confirmedById: "sup-1" }),
    );
  });

  // `changed: false` es un rechazo de negocio (faltante pedido/confirmado/cambiado
  // de forma concurrente, o formulario obsoleto): NO es un éxito. Se audita como
  // FAILURE (nunca como una confirmación exitosa), no debe pretender éxito, y
  // debe devolver un error visible en español para que el gerente refresque.
  it("treats changed:false as a business rejection: ok false + Spanish error, FAILURE audit, no fake success", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    // El faltante ya fue pedido en otra sesión: el CAS del repositorio no escribe
    // y `confirmMissingItemOk` devuelve `changed: false` con el estado actual.
    mocks.confirmMissingItemOk.mockResolvedValue({
      changed: false,
      item: {
        id: "missing-1",
        status: "PEDIDO",
        confirmedAt: null,
        confirmedById: null,
        confirmationNote: null,
      },
    });

    const res = await confirmMissingItemAction(PREV, formData());

    expect(res.ok).toBe(false);
    expect(res.error).toEqual(
      "El faltante ya fue pedido, confirmado o cambiado. Refrescá y revisá su estado actual antes de confirmar.",
    );

    expect(mocks.confirmMissingItemOk).toHaveBeenCalledWith(
      expect.objectContaining({ id: "missing-1", confirmedById: "admin-1" }),
    );

    // Perder el CAS es un intento real de confirmar sobre un estado que ya no lo
    // admitía: se audita como FAILURE, nunca como MISSING_CONFIRM_OK exitoso.
    expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
    expect(mocks.recordAudit.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        action: AUDIT_ACTIONS.MISSING_CONFIRM_OK,
        module: AUDIT_MODULES.FALTANTES,
        entity: "MissingItem",
        entityId: "missing-1",
        result: "FAILURE",
        after: { reason: "STALE_STATE", status: "PEDIDO" },
      }),
    );

    expect(mocks.revalidatePath).toHaveBeenCalledWith("/faltantes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });
});

describe("orderMissingItemAction", () => {
  it("rejects OPERADOR for both the existing- and new-supplier variants", async () => {
    grant("OPERADOR", []); // no tiene canOrderMissingItems

    await expect(
      orderMissingItemAction(PREV, orderExistingFormData()),
    ).rejects.toThrow("REDIRECT:/dashboard");
    await expect(
      orderMissingItemAction(PREV, orderNewSupplierFormData()),
    ).rejects.toThrow("REDIRECT:/dashboard");

    expect(mocks.requireCapability).toHaveBeenCalledWith("canOrderMissingItems");
    expect(mocks.orderMissingItem).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejects SUPERVISOR for both the existing- and new-supplier variants", async () => {
    grant("SUPERVISOR", ["canConfirmMissingItems"]); // no tiene canOrderMissingItems

    await expect(
      orderMissingItemAction(PREV, orderExistingFormData()),
    ).rejects.toThrow("REDIRECT:/dashboard");
    await expect(
      orderMissingItemAction(PREV, orderNewSupplierFormData()),
    ).rejects.toThrow("REDIRECT:/dashboard");

    expect(mocks.orderMissingItem).not.toHaveBeenCalled();
  });

  it("ADMIN orders from an existing supplier: audits the order and revalidates", async () => {
    grant("ADMIN", ["canOrderMissingItems"]);
    mocks.orderMissingItem.mockResolvedValue({
      item: {
        id: "missing-1",
        status: "PEDIDO",
        orderedAt: new Date("2026-07-09T12:00:00.000Z"),
        supplierId: "sup-1",
      },
      rejection: null,
    });

    await expect(
      orderMissingItemAction(PREV, orderExistingFormData()),
    ).resolves.toEqual({ error: null, ok: true });

    expect(mocks.requireCapability).toHaveBeenCalledWith("canOrderMissingItems");
    expect(mocks.orderMissingItem).toHaveBeenCalledWith({
      missingItemId: "missing-1",
      userId: "admin-1",
      supplier: { kind: "existing", supplierId: "sup-1" },
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTIONS.MISSING_ITEM_ORDERED,
        module: AUDIT_MODULES.FALTANTES,
        entity: "MissingItem",
        entityId: "missing-1",
        after: { supplierId: "sup-1", supplierCreated: false, status: "PEDIDO" },
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/faltantes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("SUPERADMIN orders from an existing supplier", async () => {
    grant("SUPERADMIN", ["canOrderMissingItems"]);
    mocks.orderMissingItem.mockResolvedValue({
      item: {
        id: "missing-1",
        status: "PEDIDO",
        orderedAt: new Date("2026-07-09T12:00:00.000Z"),
        supplierId: "sup-1",
      },
      rejection: null,
    });

    await expect(
      orderMissingItemAction(PREV, orderExistingFormData()),
    ).resolves.toEqual({ error: null, ok: true });
    expect(mocks.orderMissingItem).toHaveBeenCalledTimes(1);
  });

  it("the new-supplier branch additionally requires canManageSuppliers, rejecting an order-only ADMIN", async () => {
    // ADMIN autorizado a PEDIR pero NO a crear proveedores: pasa el primer
    // gate y es rechazado en el segundo, server-side, antes de llamar al service.
    grant("ADMIN", ["canOrderMissingItems"]);

    await expect(
      orderMissingItemAction(PREV, orderNewSupplierFormData()),
    ).rejects.toThrow("REDIRECT:/dashboard");

    expect(mocks.requireCapability).toHaveBeenCalledWith("canOrderMissingItems");
    expect(mocks.requireCapability).toHaveBeenCalledWith("canManageSuppliers");
    expect(mocks.orderMissingItem).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("ADMIN with canManageSuppliers creates a new supplier and audits supplierCreated", async () => {
    grant("ADMIN", ["canOrderMissingItems", "canManageSuppliers"]);
    mocks.orderMissingItem.mockResolvedValue({
      item: {
        id: "missing-1",
        status: "PEDIDO",
        orderedAt: new Date("2026-07-09T12:00:00.000Z"),
        supplierId: "sup-new",
      },
      rejection: null,
    });

    await expect(
      orderMissingItemAction(PREV, orderNewSupplierFormData()),
    ).resolves.toEqual({ error: null, ok: true });

    expect(mocks.requireCapability).toHaveBeenCalledWith("canManageSuppliers");
    expect(mocks.orderMissingItem).toHaveBeenCalledWith({
      missingItemId: "missing-1",
      userId: "admin-1",
      supplier: {
        kind: "new",
        name: "Droguería Central",
        phone: "555",
        address: undefined,
        email: undefined,
      },
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTIONS.MISSING_ITEM_ORDERED,
        after: { supplierId: "sup-new", supplierCreated: true, status: "PEDIDO" },
      }),
    );
  });

	const orderRejectionCases = [
		["ALREADY_ORDERED", "Este faltante ya fue pedido."],
		[
			"ALREADY_CONFIRMED",
			"Este faltante ya fue confirmado (OK gerencia) y no se puede pedir.",
		],
		["NOT_ORDERABLE", "Este faltante no se puede pedir desde su estado actual."],
		["SUPPLIER_NOT_FOUND", "No se encontró el proveedor seleccionado."],
	] as const;

	// Cada rechazo es un intento real de pedir sobre un faltante que no lo
	// admitía: se audita como FAILURE con el código de rechazo, sin datos de
	// contacto del proveedor.
	it.each(orderRejectionCases)(
		"maps %s to the exact Spanish message, audits it as FAILURE, and revalidates",
		async (rejection, error) => {
			grant("ADMIN", ["canOrderMissingItems"]);
			mocks.orderMissingItem.mockResolvedValue({ item: null, rejection });

			await expect(
				orderMissingItemAction(PREV, orderExistingFormData()),
			).resolves.toEqual({ error, ok: false });

			expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
			expect(mocks.recordAudit.mock.calls[0]![0]).toEqual(
				expect.objectContaining({
					action: AUDIT_ACTIONS.MISSING_ITEM_ORDERED,
					module: AUDIT_MODULES.FALTANTES,
					entity: "MissingItem",
					entityId: "missing-1",
					result: "FAILURE",
					after: { reason: rejection, supplierKind: "existing" },
				}),
			);

			expect(mocks.revalidatePath).toHaveBeenCalledWith("/faltantes");
			expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
		},
	);

	// Al pedir con proveedor NUEVO el formulario trae nombre/teléfono/mail. Si el
	// pedido se rechaza, ese contacto no debe quedar en el log de auditoría.
	it("keeps new-supplier contact details out of the failure audit", async () => {
		grant("ADMIN", ["canOrderMissingItems", "canManageSuppliers"]);
		mocks.orderMissingItem.mockResolvedValue({ item: null, rejection: "NOT_ORDERABLE" });

		await orderMissingItemAction(PREV, orderNewSupplierFormData());

		const auditCall = mocks.recordAudit.mock.calls[0]![0];
		expect(auditCall).toEqual(
			expect.objectContaining({
				result: "FAILURE",
				after: { reason: "NOT_ORDERABLE", supplierKind: "new" },
			}),
		);

		const serialized = JSON.stringify(auditCall);
		expect(serialized).not.toContain("Droguería Central");
		expect(serialized).not.toContain("555");
	});
});

describe("createMissingItemAction", () => {
  it("guards manual creation with canCreateMissingItems before validation or mutation", async () => {
    grant("SUPERVISOR", ["canConfirmMissingItems"]);

    await expect(
      createMissingItemAction(PREV, manualMissingFormData()),
    ).rejects.toThrow("REDIRECT:/dashboard");

    expect(mocks.requireCapability).toHaveBeenCalledWith("canCreateMissingItems");
    expect(mocks.createManualMissingItem).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("ADMIN creates a manual missing item, audits no PII, and revalidates operational views", async () => {
    grant("ADMIN", ["canCreateMissingItems"]);
    mocks.createManualMissingItem.mockResolvedValue({
      id: "missing-manual",
      productId: "prod-1",
      quantity: 3,
      originId: null,
      note: "Prioridad mostrador",
      status: "FALTANTE",
    });

    await expect(
      createMissingItemAction(PREV, manualMissingFormData()),
    ).resolves.toEqual({ error: null, ok: true });

    expect(mocks.createManualMissingItem).toHaveBeenCalledWith({
      productId: "prod-1",
      quantity: 3,
      note: "Prioridad mostrador",
      createdById: "admin-1",
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTIONS.MISSING_CREATE,
        module: AUDIT_MODULES.FALTANTES,
        entity: "MissingItem",
        entityId: "missing-manual",
        after: {
          productId: "prod-1",
          quantity: 3,
          originId: null,
          source: "manual",
          hasNote: true,
        },
      }),
    );
    expect(JSON.stringify(mocks.recordAudit.mock.calls[0]![0])).not.toContain(
      "Prioridad mostrador",
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/faltantes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });
});

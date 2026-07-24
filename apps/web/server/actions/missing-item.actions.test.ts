import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditContextFromHeaders: vi.fn(),
  createManualMissingItem: vi.fn(),
  getActiveProductsForMissingItem: vi.fn(),
  orderMissingItem: vi.fn(),
  discardMissingItems: vi.fn(),
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
  createManualMissingItem: mocks.createManualMissingItem,
  orderMissingItem: mocks.orderMissingItem,
  discardMissingItems: mocks.discardMissingItems,
}));
vi.mock("@/server/services/product.service", () => ({
  getActiveProductsForMissingItem: mocks.getActiveProductsForMissingItem,
}));

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  createMissingItemAction,
  discardMissingItemsAction,
  orderMissingItemAction,
  searchActiveProductsForMissingItemAction,
} from "./missing-item.actions";

const PREV = { error: null, ok: false };

// FormData del pedido para la rama "proveedor existente".
function orderExistingFormData(supplierId = "sup-1") {
  const data = new FormData();
  data.set("missingItemId", "missing-1");
  data.set("orderedQuantity", "20");
  data.set("supplierId", supplierId);
  return data;
}

// FormData del pedido para la rama "proveedor nuevo" (sin `supplierId`).
function orderNewSupplierFormData() {
  const data = new FormData();
  data.set("missingItemId", "missing-1");
  data.set("orderedQuantity", "20");
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
      orderedQuantity: 20,
      supplier: { kind: "existing", supplierId: "sup-1" },
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTIONS.MISSING_ITEM_ORDERED,
        module: AUDIT_MODULES.FALTANTES,
        entity: "MissingItem",
        entityId: "missing-1",
        after: {
          supplierId: "sup-1",
          supplierCreated: false,
          status: "PEDIDO",
          orderedQuantity: 20,
        },
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
      orderedQuantity: 20,
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
        after: {
          supplierId: "sup-new",
          supplierCreated: true,
          status: "PEDIDO",
          orderedQuantity: 20,
        },
      }),
    );
  });

	const orderRejectionCases = [
		["ALREADY_ORDERED", "Este faltante ya fue pedido."],
		[
			"ALREADY_CONFIRMED",
			"Este faltante ya figura como pedido y no se puede volver a pedir.",
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

	it("rejects an invalid ordered quantity server-side, before touching the service", async () => {
		grant("ADMIN", ["canOrderMissingItems"]);
		const data = orderExistingFormData();
		data.set("orderedQuantity", "0");

		const result = await orderMissingItemAction(PREV, data);

		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
		// La validación corta antes de cualquier efecto: ni pedido, ni auditoría.
		expect(mocks.orderMissingItem).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("rejects a missing ordered quantity", async () => {
		grant("ADMIN", ["canOrderMissingItems"]);
		const data = orderExistingFormData();
		data.delete("orderedQuantity");

		const result = await orderMissingItemAction(PREV, data);

		expect(result.ok).toBe(false);
		expect(mocks.orderMissingItem).not.toHaveBeenCalled();
	});

	// El pedido YA se persistió (CAS ok). Un fallo posterior de auditoría no debe
	// decirle al gerente que el pedido falló: un reintento chocaría con
	// ALREADY_ORDERED y sembraría confusión. Cubre el riesgo preexistente que
	// C2Q toca al agregar orderedQuantity a la metadata de auditoría.
	it("reports success when auditing fails after the order was persisted", async () => {
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
		mocks.recordAudit.mockRejectedValueOnce(new Error("audit unavailable"));

		await expect(
			orderMissingItemAction(PREV, orderExistingFormData()),
		).resolves.toEqual({ error: null, ok: true });
		expect(mocks.orderMissingItem).toHaveBeenCalledTimes(1);
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/faltantes");
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

  it("returns a visible error when manual creation rejects an inactive product", async () => {
    grant("ADMIN", ["canCreateMissingItems"]);
    mocks.createManualMissingItem.mockRejectedValue(new Error("Product not found"));

    await expect(
      createMissingItemAction(PREV, manualMissingFormData()),
    ).resolves.toEqual({
      error: "No se pudo registrar el faltante. Intentá de nuevo.",
      ok: false,
    });

    expect(mocks.recordAudit).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("reports success when audit context fails after the missing item was persisted", async () => {
    grant("ADMIN", ["canCreateMissingItems"]);
    mocks.createManualMissingItem.mockResolvedValue({
      id: "missing-manual",
      productId: "prod-1",
      quantity: 3,
    });
    mocks.auditContextFromHeaders.mockRejectedValue(new Error("headers unavailable"));

    await expect(
      createMissingItemAction(PREV, manualMissingFormData()),
    ).resolves.toEqual({ error: null, ok: true });
    expect(mocks.createManualMissingItem).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/faltantes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("reports success when auditing fails after the missing item was persisted", async () => {
    grant("ADMIN", ["canCreateMissingItems"]);
    mocks.createManualMissingItem.mockResolvedValue({
      id: "missing-manual",
      productId: "prod-1",
      quantity: 3,
    });
    mocks.recordAudit.mockRejectedValue(new Error("audit unavailable"));

    await expect(
      createMissingItemAction(PREV, manualMissingFormData()),
    ).resolves.toEqual({ error: null, ok: true });
    expect(mocks.createManualMissingItem).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/faltantes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("reports success when revalidation fails after the missing item was persisted", async () => {
    grant("ADMIN", ["canCreateMissingItems"]);
    mocks.createManualMissingItem.mockResolvedValue({
      id: "missing-manual",
      productId: "prod-1",
      quantity: 3,
    });
    mocks.revalidatePath.mockImplementation(() => {
      throw new Error("cache unavailable");
    });

    await expect(
      createMissingItemAction(PREV, manualMissingFormData()),
    ).resolves.toEqual({ error: null, ok: true });
    expect(mocks.createManualMissingItem).toHaveBeenCalledTimes(1);
  });
});

describe("searchActiveProductsForMissingItemAction", () => {
  it("guards with the canCreateMissingItems capability before touching the catalog", async () => {
    grant("OPERADOR", []);

    await expect(searchActiveProductsForMissingItemAction("amoxi")).rejects.toThrow(
      "REDIRECT:/dashboard",
    );

    expect(mocks.getActiveProductsForMissingItem).not.toHaveBeenCalled();
  });

  it("returns nothing for a blank query instead of listing the catalog", async () => {
    grant("ADMIN", ["canCreateMissingItems"]);

    await expect(searchActiveProductsForMissingItemAction("   ")).resolves.toEqual({
      items: [],
      nextCursor: null,
    });

    expect(mocks.getActiveProductsForMissingItem).not.toHaveBeenCalled();
  });

  it("delegates a trimmed query to the bounded active-product search", async () => {
    grant("ADMIN", ["canCreateMissingItems"]);
    mocks.getActiveProductsForMissingItem.mockResolvedValue({
      items: [{ id: "prod-1", name: "Amoxicilina", code: "AMO-1" }],
      nextCursor: "cursor-2",
    });

    await expect(searchActiveProductsForMissingItemAction("  amoxi  ")).resolves.toEqual({
      items: [{ id: "prod-1", name: "Amoxicilina", code: "AMO-1" }],
      nextCursor: "cursor-2",
    });

    expect(mocks.getActiveProductsForMissingItem).toHaveBeenCalledWith({
      q: "amoxi",
      cursor: undefined,
    });
  });

  it("forwards the cursor so load more keeps paginating the same query", async () => {
    grant("SUPERADMIN", ["canCreateMissingItems"]);
    mocks.getActiveProductsForMissingItem.mockResolvedValue({ items: [], nextCursor: null });

    await searchActiveProductsForMissingItemAction("amoxi", "cursor-2");

    expect(mocks.getActiveProductsForMissingItem).toHaveBeenCalledWith({
      q: "amoxi",
      cursor: "cursor-2",
    });
  });
});

function discardFormData(ids: string[], reason?: string) {
  const data = new FormData();
  // Los checkboxes del lote postean el MISMO nombre repetido: por eso el action
  // usa `getAll` y no `get`.
  for (const id of ids) data.append("ids", id);
  if (reason !== undefined) data.set("reason", reason);
  return data;
}

describe("discardMissingItemsAction", () => {
  const PREV_STATE = { error: null, ok: false };

  // `clearAllMocks` del beforeEach global limpia las LLAMADAS pero no las
  // implementaciones: los casos de "auditoría caída" y "cache caída" de más
  // arriba dejan sus rechazos puestos. Se resetean acá para que este bloque
  // pruebe el descarte y no el estado que dejó otro test.
  beforeEach(() => {
    mocks.recordAudit.mockReset();
    mocks.revalidatePath.mockReset();
    mocks.auditContextFromHeaders.mockResolvedValue({ userId: "adm-1", channel: "web" });
  });

  // El punto que pidió gerencia: descartar es autoridad de compras, no de
  // cualquiera que pueda ver la cola.
  it("exige la capacidad de compras y corta antes de tocar la base", async () => {
    mocks.requireCapability.mockRejectedValueOnce(new Error("REDIRECT:/dashboard"));

    await expect(
      discardMissingItemsAction(PREV_STATE, discardFormData(["m-1"])),
    ).rejects.toThrow("REDIRECT:/dashboard");

    expect(mocks.requireCapability).toHaveBeenCalledWith("canOrderMissingItems");
    expect(mocks.discardMissingItems).not.toHaveBeenCalled();
  });

  it("lee todos los ids seleccionados, no solo el primero", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "adm-1", role: "ADMIN" } });
    mocks.discardMissingItems.mockResolvedValue({
      discarded: ["m-1", "m-2", "m-3"],
      skipped: [],
    });

    const result = await discardMissingItemsAction(
      PREV_STATE,
      discardFormData(["m-1", "m-2", "m-3"], "Duplicado"),
    );

    expect(result).toEqual({ error: null, ok: true });
    expect(mocks.discardMissingItems).toHaveBeenCalledWith({
      ids: ["m-1", "m-2", "m-3"],
      discardedById: "adm-1",
      reason: "Duplicado",
    });
  });

  it("deduplica ids repetidos antes de llegar al service", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "adm-1", role: "ADMIN" } });
    mocks.discardMissingItems.mockResolvedValue({ discarded: ["m-1"], skipped: [] });

    await discardMissingItemsAction(PREV_STATE, discardFormData(["m-1", "m-1"]));

    expect(mocks.discardMissingItems).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ["m-1"] }),
    );
  });

  it("rechaza una selección vacía sin llamar al service", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "adm-1", role: "ADMIN" } });

    const result = await discardMissingItemsAction(PREV_STATE, discardFormData([]));

    expect(result.ok).toBe(false);
    expect(mocks.discardMissingItems).not.toHaveBeenCalled();
  });

  // Una entrada por faltante: el lote es comodidad de la pantalla, no una
  // unidad de negocio. Quién descartó QUÉ es la pregunta que alguien va a hacer.
  it("audita un registro por faltante descartado, no uno por lote", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "adm-1", role: "ADMIN" } });
    mocks.discardMissingItems.mockResolvedValue({
      discarded: ["m-1", "m-2"],
      skipped: ["m-3"],
    });

    await discardMissingItemsAction(PREV_STATE, discardFormData(["m-1", "m-2", "m-3"]));

    const discardCalls = mocks.recordAudit.mock.calls.filter(
      (call) => call[0].action === AUDIT_ACTIONS.MISSING_DISCARDED,
    );
    expect(discardCalls).toHaveLength(2);
    expect(discardCalls.map((call) => call[0].entityId)).toEqual(["m-1", "m-2"]);
    // El salteado NO se audita como descartado: nunca se escribió.
    expect(discardCalls.map((call) => call[0].entityId)).not.toContain("m-3");
  });

  // Otro gerente llegó primero. Se informa sin pretender que hubo una falla.
  it("informa cuando ninguno seguía abierto", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "adm-1", role: "ADMIN" } });
    mocks.discardMissingItems.mockResolvedValue({ discarded: [], skipped: ["m-1"] });

    const result = await discardMissingItemsAction(PREV_STATE, discardFormData(["m-1"]));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/seguía abierto/i);
  });
});

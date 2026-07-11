import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `useActionState` es lo que trae el `{ ok, error }` de la Server Action al
// render. Lo mockeamos para fijar el estado devuelto y afirmar que un rechazo
// LLEGA A LA PANTALLA — antes el formulario descartaba el error con un
// wrapper `Promise<void>`.
const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

// La Server Action no corre en el render: solo tiene que existir para que
// `useActionState` la reciba. Mockearla evita arrastrar "use server" y
// next/cache al entorno de test.
vi.mock("@/server/actions/missing-item.actions", () => ({
	confirmMissingItemAction: vi.fn(),
	orderMissingItemAction: vi.fn(),
}));

import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

import { MissingList } from "./missing-list";

const now = new Date("2026-06-06T12:00:00.000Z");

function item(overrides: Partial<MissingItemListItem>): MissingItemListItem {
  return {
    id: "missing-id",
    quantity: 1,
    status: "FALTANTE",
    originId: null,
    confirmedAt: null,
    confirmedById: null,
    confirmationNote: null,
    orderedAt: null,
    orderedById: null,
    supplierId: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    product: {
      id: "product-id",
      name: "Producto",
      code: "COD-1",
      unit: "unidad",
      laboratory: null,
    },
    origin: null,
    supplier: null,
    ...overrides,
  };
}

function origin(
  overrides: Partial<NonNullable<MissingItemListItem["origin"]>>,
): NonNullable<MissingItemListItem["origin"]> {
  return {
    id: "pending-id",
    promisedAt: new Date("2026-06-06T18:00:00.000Z"),
    status: "PENDIENTE",
    customerName: "Cliente",
    ...overrides,
  };
}

type ActionState = { error: string | null; ok: boolean };

const IDLE: ActionState = { error: null, ok: false };

function mockActionState(state: ActionState, isPending = false) {
  useActionStateMock.mockReturnValue([state, vi.fn(), isPending]);
}

function renderMissingList(
	items: MissingItemListItem[],
	canConfirm = false,
	canOrder = false,
): string {
	return renderToStaticMarkup(
		createElement(MissingList, {
			items,
			nextCursor: null,
			canConfirm,
			canOrder,
			now,
		}),
	);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockActionState(IDLE);
});

describe("MissingList render contract", () => {
  it("renders page overview tiles with loaded, open, and confirmed counts", () => {
    const confirmedAt = new Date("2026-06-06T12:00:00.000Z");
    const html = renderMissingList([
      item({ id: "open-missing", product: product("Open missing", "OPEN-1") }),
      item({ id: "open-ordered", status: "PEDIDO", product: product("Open ordered", "OPEN-2") }),
      item({ id: "confirmed", status: "RECIBIDO", confirmedAt, product: product("Confirmed", "CONF-1") }),
      item({ id: "cancelled", status: "CANCELADO", product: product("Cancelled", "CANC-1") }),
    ]);

    expect(html).toContain("Vista de la página");
    expect(html).toContain("Seguimiento operativo");
    expect(html).toMatch(/En esta página[\s\S]*<p[^>]*>4<\/p>[\s\S]*Registros cargados ahora/);
    expect(html).toMatch(/Abiertos[\s\S]*<p[^>]*>2<\/p>[\s\S]*Faltante o pedido sin confirmar/);
    expect(html).toMatch(/Confirmados[\s\S]*<p[^>]*>1<\/p>[\s\S]*Con OK gerencia/);
  });

  it("renders confirmation metadata in the card and table markup", () => {
    const confirmedAt = new Date("2026-06-06T12:00:00.000Z");
    const confirmedLabel = `Confirmado: ${formatBogotaDate(confirmedAt, { style: "datetime" })}`;
    const html = renderMissingList([
      item({
        id: "confirmed-open-status",
        confirmedAt,
        product: product("Confirmed product", "CONF-1"),
        originId: "pending-id",
        origin: origin({ promisedAt: new Date("2026-06-06T13:00:00.000Z") }),
      }),
      item({ id: "pending", product: product("Pending product", "PEND-1") }),
    ]);

    expect(countOccurrences(html, confirmedLabel)).toBe(2);
    expect(countOccurrences(html, "Pendiente")).toBe(2);
    expect(html).toMatch(
      new RegExp(
        `class="space-y-3 lg:hidden"[\\s\\S]*Confirmación: <span[^>]*>${escapeRegex(
          confirmedLabel,
        )}<\\/span>`,
      ),
    );
    expect(html).toMatch(
      new RegExp(
        `<table[\\s\\S]*<th[^>]*>Confirmación<\\/th>[\\s\\S]*<td[^>]*><span[^>]*>${escapeRegex(
          confirmedLabel,
        )}<\\/span><\\/td>`,
      ),
    );
  });
});

describe("MissingList · order visibility", () => {
  const orderedAt = new Date("2026-06-05T15:30:00.000Z");
  const supplier = { id: "supplier-id", name: "Distribuidora Norte" };
  const orderedLabel = formatBogotaDate(orderedAt, { style: "datetime" });

  it("shows supplier and order date for an ordered item in both card and table", () => {
    const html = renderMissingList([
      item({
        id: "pedido-1",
        status: "PEDIDO",
        orderedAt,
        supplier,
        supplierId: supplier.id,
        product: product("Pedido", "PED-1"),
      }),
    ]);

    // Una vez en la tarjeta mobile y otra en la fila desktop.
    expect(countOccurrences(html, "Distribuidora Norte")).toBe(2);
    expect(countOccurrences(html, orderedLabel)).toBe(2);
    expect(html).toMatch(new RegExp(`<th[^>]*>Pedido<\\/th>`));
  });

  it("shows no order detail for an item that has not been ordered", () => {
    const html = renderMissingList([
      item({ id: "faltante-1", product: product("Faltante", "FALT-1") }),
    ]);

    expect(html).not.toContain("Distribuidora Norte");
    expect(html).not.toContain(orderedLabel);
  });

  // El faltante cerrado conserva proveedor y fecha, pero la orden ya no está en
  // curso: mostrarla lo haría leer como un pedido vivo.
  it("shows no order detail once the item reached a closed status", () => {
    const html = renderMissingList([
      item({
        id: "recibido-1",
        status: "RECIBIDO",
        orderedAt,
        supplier,
        supplierId: supplier.id,
        product: product("Recibido", "REC-1"),
      }),
    ]);

    expect(html).not.toContain("Distribuidora Norte");
    expect(html).not.toContain(orderedLabel);
  });

  it("renders an ordered item whose supplier did not load, without breaking", () => {
    const html = renderMissingList([
      item({
        id: "pedido-sin-proveedor",
        status: "PEDIDO",
        orderedAt,
        product: product("Pedido", "PED-2"),
      }),
    ]);

    expect(countOccurrences(html, orderedLabel)).toBe(2);
    expect(html).toContain("Proveedor sin registrar");
  });
});

describe("MissingList · confirmation gating", () => {
  it("renders the confirm form only for FALTANTE unconfirmed items when canConfirm is true", () => {
    mockActionState(IDLE);
    const html = renderMissingList(
      [
        item({ id: "faltante-1", product: product("Faltante", "FALT-1") }),
        item({
          id: "pedido-1",
          status: "PEDIDO",
          product: product("Pedido", "PED-1"),
        }),
        item({
          id: "recibido-1",
          status: "RECIBIDO",
          confirmedAt: new Date("2026-06-06T10:00:00.000Z"),
          product: product("Recibido", "REC-1"),
        }),
        item({
          id: "cancelado-1",
          status: "CANCELADO",
          product: product("Cancelado", "CANC-1"),
        }),
      ],
      true,
    );

    // El check de confirmación solo aparece para el faltante confirmable.
    expect(html).toContain('aria-label="Confirmar (OK gerencia)"');
    expect(html).toContain('name="id" value="faltante-1"');
    // No se ofrece confirmación sobre PEDIDO ni estados cerrados.
    expect(html).not.toContain('name="id" value="pedido-1"');
    expect(html).not.toContain('name="id" value="recibido-1"');
    expect(html).not.toContain('name="id" value="cancelado-1"');
  });

  it("renders no confirm form when canConfirm is false, even for confirmable items", () => {
    mockActionState(IDLE);
    const html = renderMissingList(
      [item({ id: "faltante-1", product: product("Faltante", "FALT-1") })],
      false,
    );

    expect(html).not.toContain("Confirmar (OK gerencia)");
    expect(html).not.toContain('name="id"');
    // Sin la columna Acción del encabezado desktop.
	expect(html).not.toContain("Acción");
	});

	it("renders the order form only for FALTANTE unconfirmed items when canOrder is true", () => {
		mockActionState(IDLE);
		const html = renderMissingList(
			[
				item({ id: "faltante-1", product: product("Faltante", "FALT-1") }),
				item({ id: "pedido-1", status: "PEDIDO", product: product("Pedido", "PED-1") }),
				item({
					id: "confirmado-1",
					confirmedAt: new Date("2026-06-06T10:00:00.000Z"),
					product: product("Confirmado", "CONF-1"),
				}),
			],
			false,
			true,
		);

		expect(html).toContain('name="missingItemId" value="faltante-1"');
		expect(html).toContain("Nombre del proveedor");
		expect(html).toContain("Pedir");
		expect(html).not.toContain('name="missingItemId" value="pedido-1"');
		expect(html).not.toContain('name="missingItemId" value="confirmado-1"');
	});
});

describe("MissingList · action error contract", () => {
	it("surfaces the confirmation rejection returned by the server action", () => {
		const message = "No se pudo marcar OK. Intentá de nuevo.";
		mockActionState({ error: message, ok: false });

    const html = renderMissingList(
      [item({ id: "faltante-1", product: product("Faltante", "FALT-1") })],
      true,
    );

		expect(html).toContain('role="alert"');
		expect(html).toContain(message);
	});

	it("surfaces the order rejection returned by the server action", () => {
		const message = "Este faltante ya fue pedido.";
		mockActionState({ error: message, ok: false });

		const html = renderMissingList(
			[item({ id: "faltante-1", product: product("Faltante", "FALT-1") })],
			false,
			true,
		);

		expect(html).toContain('role="alert"');
		expect(html).toContain(message);
	});

	it("renders no alert while the action has not rejected", () => {
    mockActionState(IDLE);

    const html = renderMissingList(
      [item({ id: "faltante-1", product: product("Faltante", "FALT-1") })],
      true,
    );

    expect(html).not.toContain('role="alert"');
  });

  it("wires the confirm form to the stateful action, not to a fire-and-forget wrapper", () => {
    mockActionState(IDLE);

    renderMissingList(
      [item({ id: "faltante-1", product: product("Faltante", "FALT-1") })],
      true,
    );

	// El item confirmable se renderiza dos veces (tarjeta mobile + fila
	// desktop, una sola visible por CSS), así que hay dos instancias del
	// formulario y dos llamadas a `useActionState`. Un wrapper `Promise<void>`
	// (que descarta `{ ok, error }`) no podría alimentar el hook ninguna vez.
	expect(useActionStateMock).toHaveBeenCalledTimes(2);
	});
});

function product(
  name: string,
  code: string,
): MissingItemListItem["product"] {
  return {
    id: code.toLowerCase(),
    name,
    code,
    unit: "unidad",
    laboratory: null,
  };
}

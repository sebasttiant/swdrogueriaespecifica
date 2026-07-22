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
    orderedQuantity: null,
    note: null,
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
    confirmedBy: null,
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
	canOrder = false,
	options: {
		suppliers?: { id: string; name: string }[];
		canCreateSupplier?: boolean;
	} = {},
): string {
	return renderToStaticMarkup(
		createElement(MissingList, {
			items,
			nextCursor: null,
			canOrder,
			now,
			suppliers: options.suppliers ?? [],
			canCreateSupplier: options.canCreateSupplier ?? true,
		}),
	);
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockActionState(IDLE);
});

describe("MissingList render contract", () => {
  // `/faltantes` es una cola operativa: lo primero que el gerente ve al abrirla
  // desde el celular tiene que ser un faltante accionable, no un tablero. Los
  // indicadores de página (tiles grandes con su título y su párrafo explicativo)
  // empujaban la primera tarjeta fuera de la pantalla.
  it("renders no page-overview dashboard, leading with the actionable item instead", () => {
    const html = renderMissingList([
      item({ id: "open-missing", product: product("Open missing", "OPEN-1") }),
    ]);

    expect(html).not.toContain("Vista de la página");
    expect(html).not.toContain("Seguimiento operativo");
    expect(html).not.toContain("Registros cargados ahora");
    expect(html).not.toContain("Faltante o pedido sin confirmar");
    expect(html).toContain("Open missing");
  });

  // El detalle secundario (origen, promesa, pedido) sigue disponible, pero
  // colapsado: en la cola no se lee contexto, se actúa.
  it("keeps the secondary detail collapsed behind a disclosure", () => {
    const html = renderMissingList([
      item({
        id: "open-missing",
        product: product("Open missing", "OPEN-1"),
        originId: "pending-id",
        origin: origin({}),
      }),
    ]);

    expect(html).toContain("<details");
    expect(html).toContain("Ver detalle");
  });

  it("renders a manual note in both the mobile card and desktop table", () => {
    const note = "Prioridad mostrador";
    const html = renderMissingList([
      item({ id: "manual-note", note, product: product("Manual product", "MAN-1") }),
    ]);

    expect(countOccurrences(html, `Nota: ${note}`)).toBe(2);
    expect(html).toMatch(new RegExp(`<th[^>]*>Nota<\\/th>`));
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

  it("shows the ordered quantity for an ordered item in both card and table", () => {
    const html = renderMissingList([
      item({
        id: "pedido-1",
        status: "PEDIDO",
        orderedAt,
        orderedQuantity: 20,
        supplier,
        supplierId: supplier.id,
        product: product("Pedido", "PED-1"),
      }),
    ]);

    expect(countOccurrences(html, "Cantidad pedida: 20 unidades")).toBe(2);
  });

  // Pedido anterior a la columna: se pidió, pero la cantidad no quedó
  // registrada. Nunca se muestra `quantity` (necesidad) como si fuera lo pedido.
  it("marks the ordered quantity as unregistered for a legacy ordered item", () => {
    const html = renderMissingList([
      item({
        id: "pedido-legacy",
        status: "PEDIDO",
        orderedAt,
        orderedQuantity: null,
        quantity: 3,
        supplier,
        supplierId: supplier.id,
        product: product("Pedido legacy", "PED-2"),
      }),
    ]);

    expect(countOccurrences(html, "Cantidad pedida no registrada")).toBe(2);
    expect(html).not.toContain("Cantidad pedida: 3");
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

describe("MissingList · order gating", () => {
  it("renders the order form only for FALTANTE unconfirmed items when canOrder is true", () => {
    mockActionState(IDLE);
    const html = renderMissingList(
      [
        item({ id: "faltante-1", product: product("Faltante", "FALT-1") }),
        item({ id: "pedido-1", status: "PEDIDO", product: product("Pedido", "PED-1") }),
        item({
          id: "historico-1",
          confirmedAt: new Date("2026-06-06T10:00:00.000Z"),
          product: product("Historico", "HIST-1"),
        }),
      ],
      true,
    );

    expect(html).toContain('name="missingItemId" value="faltante-1"');
    expect(html).toContain("Pedir");
    expect(html).not.toContain('name="missingItemId" value="pedido-1"');
    expect(html).not.toContain('name="missingItemId" value="historico-1"');
  });

  // El formulario de pedido nace colapsado: la fila ofrece el disparador
  // "Pedir", no un formulario abierto que empuje la lista fuera de pantalla.
  it("renders the order form collapsed, mounting no supplier fields in the list", () => {
    mockActionState(IDLE);
    const html = renderMissingList(
      [item({ id: "faltante-1", product: product("Faltante", "FALT-1") })],
      true,
      { suppliers: [{ id: "sup-1", name: "Distribuidora Norte" }] },
    );

    expect(html).toContain("Pedir");
    expect(html).not.toContain('name="supplierId"');
    expect(html).not.toContain("Nombre del proveedor");
    expect(html).not.toContain("Distribuidora Norte");
  });

  it("offers no action at all when the user cannot order", () => {
    mockActionState(IDLE);
    const html = renderMissingList(
      [item({ id: "faltante-1", product: product("Faltante", "FALT-1") })],
      false,
    );

    expect(html).not.toContain("Pedir");
    expect(html).not.toContain('name="missingItemId"');
    // Sin la columna Acción del encabezado desktop.
    expect(html).not.toContain("Acción");
  });
});

// "OK gerencia" registraba que gerencia YA había pedido, pero sin proveedor y
// sin pasar a PEDIDO. Convivía con "Pedir" bajo la MISMA condición, así que la
// misma fila ofrecía dos caminos para el mismo hecho. "Pedir" queda como única
// transición operativa; `confirmedAt` sobrevive en los datos y lo tratan C2/C3.
describe("MissingList · no ambiguous authorization path", () => {
  const AUTHORIZATION_WORDING = [
    "Autorizar",
    "Autorizado",
    "Autorizados",
    "Autorización",
    "OK gerencia",
    "Confirmar",
    "Confirmación",
  ];

  it.each(AUTHORIZATION_WORDING)("never renders %s anywhere in the list", (wording) => {
    mockActionState(IDLE);
    const html = renderMissingList(
      [
        item({ id: "faltante-1", product: product("Faltante", "FALT-1") }),
        item({
          id: "historico-1",
          confirmedAt: new Date("2026-06-06T10:00:00.000Z"),
          confirmedById: "admin-1",
          confirmedBy: { id: "admin-1", name: "Ana Gerente" },
          product: product("Historico", "HIST-1"),
        }),
      ],
      true,
    );

    expect(html).not.toContain(wording);
  });

  // La fila histórica sigue existiendo y renderizando; lo que desaparece es el
  // camino ambiguo, no el registro.
  it("still renders a row that carries confirmedAt, without offering the removed action", () => {
    mockActionState(IDLE);
    const html = renderMissingList(
      [
        item({
          id: "historico-1",
          confirmedAt: new Date("2026-06-06T10:00:00.000Z"),
          confirmedById: "admin-1",
          confirmedBy: { id: "admin-1", name: "Ana Gerente" },
          product: product("Historico", "HIST-1"),
        }),
      ],
      true,
    );

    expect(html).toContain("Historico");
    expect(html).toContain("HIST-1");
    // El nombre del responsable histórico no se muestra todavía: C2 lo trae de
    // vuelta como "pedido histórico", con su proveedor sin registrar.
    expect(html).not.toContain("Ana Gerente");
  });
});

describe("MissingList · action error contract", () => {
  it("surfaces the order rejection returned by the server action", () => {
    const message = "Este faltante ya fue pedido.";
    mockActionState({ error: message, ok: false });

    const html = renderMissingList(
      [item({ id: "faltante-1", product: product("Faltante", "FALT-1") })],
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

  it("wires the order form to the stateful action, not to a fire-and-forget wrapper", () => {
    mockActionState(IDLE);

    renderMissingList(
      [item({ id: "faltante-1", product: product("Faltante", "FALT-1") })],
      true,
    );

    // El item se renderiza dos veces (tarjeta mobile + fila desktop, una sola
    // visible por CSS), así que hay dos instancias del formulario y dos llamadas
    // a `useActionState`. Un wrapper `Promise<void>` (que descarta
    // `{ ok, error }`) no podría alimentar el hook ninguna vez.
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

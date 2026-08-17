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
	markMissingItemsOrderedAction: vi.fn(),
	discardMissingItemsAction: vi.fn(),
}));

import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";
import type { MissingItemListEntry } from "@/server/services/missing-item.service";

import { MissingList } from "./missing-list";

const now = new Date("2026-06-06T12:00:00.000Z");

function item(overrides: Partial<MissingItemListEntry>): MissingItemListEntry {
  return {
    id: "missing-id",
    quantity: 1,
    orderedQuantity: null,
    receivedQuantity: 0,
    note: null,
    status: "FALTANTE",
    originId: null,
    confirmedAt: null,
    confirmedById: null,
    confirmationNote: null,
    orderedAt: null,
    orderedById: null,
    orderedBy: null,
    discardedAt: null,
    discardedById: null,
    discardedBy: null,
    supplierId: null,
    sellerCode: null,
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
    createdBy: { id: "creator-1", name: "Creador Demo" },
    // Ya resuelto por el service (reporter o createdBy). Null por defecto para
    // no inyectar la línea de solicitante en tests que no la prueban.
    requestedByName: null,
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

// `canAct` = autoridad de compras. Un solo eje ahora: la fila ya no monta el
// formulario largo, así que "poder pedir" dejó de depender de que existan
// proveedores cargados.
function renderMissingList(
	items: MissingItemListEntry[],
	canAct = false,
	options: {
		// Ver los badges de seguimiento es un eje aparte de poder actuar. Por
		// defecto siguen a `canAct` (gerencia ve todo), pero los tests de
		// Mejora 4 los fijan por separado para probar la independencia.
		canSeeStatus?: boolean;
		// Identidad del proveedor: eje propio. Por defecto sigue a `canAct`
		// (gerencia), y los tests de la fuga lo fijan aparte.
		canSeeSupplier?: boolean;
	} = {},
): string {
	return renderToStaticMarkup(
		createElement(MissingList, {
			items,
			nextCursor: null,
			pageHref: (cursor: string) => `/faltantes?cursor=${cursor}`,
			canQuickAct: canAct,
			canSeeStatus: options.canSeeStatus ?? canAct,
			canSeeSupplier: options.canSeeSupplier ?? canAct,
			now,
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

  it("renders the seller code in both the mobile card and desktop table", () => {
    const html = renderMissingList([
      item({ sellerCode: "VEN-12", product: product("Manual product", "MAN-1") }),
    ]);

    expect(countOccurrences(html, "VEN-12")).toBe(2);
    expect(html).toMatch(/<th[^>]*>Referencia<\/th>/);
  });

  it("keeps the calculated deficit for automatic missing items", () => {
    const html = renderMissingList([
      item({ originId: "pending-1", origin: origin({}), quantity: 4 }),
    ]);

    expect(html).toContain("4 unidad");
    expect(html).toContain(">4<span");
  });
});

// Estos casos describen la vista de GERENCIA: quien tiene
// `canViewSupplierIdentity` sí ve proveedor, fecha y cantidad pedida. La vista
// del vendedor se cubre en el bloque de más abajo.
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
    ], false, { canSeeSupplier: true });

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
        receivedQuantity: 8,
        supplier,
        supplierId: supplier.id,
        product: product("Pedido", "PED-1"),
      }),
    ], false, { canSeeSupplier: true });

    // "Faltaban N · llegaron M", nunca "pediste N" (D10). El gerente no declara
    // una cantidad: toca un chulito y el sistema deriva lo que faltaba.
    // Escribirle "pediste 20" le atribuiría una decisión que no tomó.
    expect(countOccurrences(html, "Faltaban 20 · llegaron 8")).toBe(2);
    expect(html).not.toContain("Cantidad pedida");
  });

  // Pedido anterior al backfill: se pidió, pero la cantidad esperada no quedó
  // registrada. Nunca se muestra `quantity` en su lugar como si fuera lo mismo.
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
    ], false, { canSeeSupplier: true });

    expect(countOccurrences(html, "Cantidad esperada no registrada")).toBe(2);
    expect(html).not.toContain("Faltaban 3");
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
    ], false, { canSeeSupplier: true });

    expect(countOccurrences(html, orderedLabel)).toBe(2);
    expect(html).toContain("Proveedor sin registrar");
  });
});

describe("MissingList · order gating", () => {
  it("ofrece las dos acciones solo en un FALTANTE sin confirmar", () => {
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

    expect(html).toContain("Marcar Faltante como pedido");
    expect(html).toContain("Descartar Faltante");
    // Una fila ya pedida o ya confirmada no tiene nada que marcar.
    expect(html).not.toContain("Marcar Pedido como pedido");
    expect(html).not.toContain("Marcar Historico como pedido");
  });

  // REGRESIÓN (reportada en producción el 2026-07-30): la fila mostraba
  // "✓ Pedido" y "Pedir" pegados. Dos botones con nombres casi idénticos y
  // efectos distintos, en la pantalla que un gerente de 60 años usa para marcar
  // decenas de filas seguidas desde el celular.
  //
  // La cola de trabajo no vuelve a montar el formulario largo: ni el disparador
  // "Pedir", ni cantidad, ni proveedor. Marcar es un toque y nada más.
  it("no monta el formulario de proveedor y cantidad en la cola", () => {
    mockActionState(IDLE);
    const html = renderMissingList(
      [item({ id: "faltante-1", product: product("Faltante", "FALT-1") })],
      true,
    );

    expect(html).not.toContain("Cantidad a pedir");
    expect(html).not.toContain('name="supplierId"');
    expect(html).not.toContain('name="orderedQuantity"');
    expect(html).not.toContain("Elegí un proveedor");
    expect(html).not.toContain("Nombre del proveedor");
  });

  it("no ofrece ninguna acción a quien no es autoridad de compras", () => {
    mockActionState(IDLE);
    const html = renderMissingList(
      [item({ id: "faltante-1", product: product("Faltante", "FALT-1") })],
      false,
    );

    expect(html).not.toContain("como pedido");
    expect(html).not.toContain('name="ids"');
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

// Mejora 4: el vendedor reporta y sigue operando. En su vista de la cola no va
// el seguimiento de gerencia (badges de estado y vencimiento); gerencia sí lo ve.
describe("MissingList · status visibility (Mejora 4)", () => {
  function tracked() {
    return item({
      id: "seg-1",
      status: "RECIBIDO",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date("2026-06-06T18:00:00.000Z") }),
      product: product("Producto seguimiento", "SEG-1"),
    });
  }

  it("hides the status badge and the Estado column from the seller", () => {
    const html = renderMissingList([tracked()], false, { canSeeStatus: false });

    expect(html).not.toContain("Recibido");
    expect(html).not.toMatch(/<th[^>]*>Estado<\/th>/);
  });

  it("shows the status badge and the Estado column to gerencia", () => {
    const html = renderMissingList([tracked()], true, { canSeeStatus: true });

    // Una vez en la tarjeta mobile y otra en la fila desktop.
    expect(countOccurrences(html, "Recibido")).toBe(2);
    expect(html).toMatch(/<th[^>]*>Estado<\/th>/);
  });

  // La visibilidad del seguimiento NO depende de poder pedir: un gerente sin
  // proveedores (canOrder false) igual ve el estado.
  it("keeps the status visible for gerencia even when ordering is unavailable", () => {
    const html = renderMissingList([tracked()], false, { canSeeStatus: true });

    expect(html).toContain("Recibido");
  });
});

// Mejora 5: quién pidió el faltante. `requestedByName` ya viene resuelto por el
// service (reporter del vendedor o createdBy). La lista solo lo muestra.
describe("MissingList · requester traceability (Mejora 5)", () => {
  it("shows the requester in the card line and the desktop column", () => {
    const html = renderMissingList([
      item({
        id: "m-1",
        requestedByName: "Juan Vendedor",
        product: product("Producto", "PR-1"),
      }),
    ]);

    // "Solicitado por" aparece dos veces: encabezado de columna + línea de la
    // tarjeta mobile.
    expect(countOccurrences(html, "Solicitado por")).toBe(2);
    expect(html).toContain("Solicitado por Juan Vendedor");
    // El nombre: una vez en la tarjeta, otra en la celda desktop.
    expect(countOccurrences(html, "Juan Vendedor")).toBe(2);
  });

  it("omits the card line when no requester is known, keeping only the column header", () => {
    const html = renderMissingList([
      item({ id: "m-1", requestedByName: null, product: product("Producto", "PR-1") }),
    ]);

    // Solo el encabezado; sin línea de solicitante en la tarjeta.
    expect(countOccurrences(html, "Solicitado por")).toBe(1);
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

  it("cablea las acciones al hook con estado, no a un wrapper que descarta el resultado", () => {
    mockActionState(IDLE);

    renderMissingList(
      [item({ id: "faltante-1", product: product("Faltante", "FALT-1") })],
      true,
    );

    // El item se renderiza dos veces (tarjeta mobile + fila desktop, una sola
    // visible por CSS). Cada render monta DOS acciones con estado: el ✓ y el ✗.
    // Un wrapper `Promise<void>` (que descarta `{ ok, error }`) no podría
    // alimentar el hook ninguna vez, y el gerente no vería por qué falló.
    const RENDERS_PER_ITEM = 2;
    const STATEFUL_ACTIONS_PER_RENDER = 2;
    expect(useActionStateMock).toHaveBeenCalledTimes(
      RENDERS_PER_ITEM * STATEFUL_ACTIONS_PER_RENDER,
    );
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

// La regla de negocio: un vendedor NO debe saber a qué depósito le compra la
// droguería. Estos casos son la contraparte de "order visibility": misma fila,
// mirada sin `canViewSupplierIdentity`.
describe("MissingList · el proveedor no existe para el vendedor", () => {
  const orderedAt = new Date("2026-06-05T15:30:00.000Z");
  const supplier = { id: "supplier-id", name: "Distribuidora Norte" };

  function orderedItem() {
    return item({
      id: "pedido-1",
      status: "PEDIDO",
      orderedAt,
      orderedQuantity: 8,
      supplier,
      supplierId: supplier.id,
      product: product("Loratadina 10mg", "MED-003"),
    });
  }

  it("no filtra el nombre del proveedor en ninguna parte del HTML", () => {
    const html = renderMissingList([orderedItem()], false, {
      canSeeSupplier: false,
    });

    // No basta con que no se VEA: no puede estar en el markup, porque el
    // payload se lee desde el inspector del navegador.
    expect(html).not.toContain("Distribuidora Norte");
    expect(html).not.toContain("supplier-id");
    expect(html).not.toContain("Proveedor sin registrar");
  });

  it("no renderiza la columna Pedido ni la cantidad pedida", () => {
    const html = renderMissingList([orderedItem()], false, {
      canSeeSupplier: false,
    });

    expect(html).not.toMatch(/<th[^>]*>Pedido<\/th>/);
    expect(html).not.toContain("Cantidad pedida");
  });

  // Lo operativo sigue estando: el vendedor ve QUÉ falta y CUÁNTO, que es su
  // trabajo. Solo se le oculta a quién se le compra.
  it("conserva el producto, la cantidad y el solicitante", () => {
    const html = renderMissingList([orderedItem()], false, {
      canSeeSupplier: false,
    });

    expect(html).toContain("Loratadina 10mg");
    expect(html).toContain("MED-003");
  });

  it("sí lo muestra a gerencia sobre la misma fila", () => {
    const html = renderMissingList([orderedItem()], false, {
      canSeeSupplier: true,
    });

    expect(html).toContain("Distribuidora Norte");
    expect(html).toMatch(/<th[^>]*>Pedido<\/th>/);
  });
});

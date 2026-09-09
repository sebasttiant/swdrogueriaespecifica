import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `useActionState` es lo que trae el `{ ok, error }` de la Server Action al
// render. Se mockea para fijar el estado devuelto y afirmar que un rechazo
// LLEGA A LA PANTALLA, igual que en `missing-list.render.test.ts`.
const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

vi.mock("@/server/actions/missing-item.actions", () => ({
  discardMissingItemsAction: vi.fn(),
  markMissingItemsOrderedAction: vi.fn(),
}));

import { MISSING_BULK_FORM_ID } from "./missing-bulk-selection";
import { MissingBulkActions } from "./missing-bulk-actions";

type ActionState = { error: string | null; ok: boolean };

const IDLE: ActionState = { error: null, ok: false };

function mockActionStates(order: ActionState, discard: ActionState = IDLE) {
  // `mockReset()` primero: `mockReturnValueOnce` encadena sobre una cola, y
  // sin vaciarla acá, la cola de un test anterior (o del `beforeEach`) se
  // arrastra y el componente consume el valor equivocado en el orden
  // equivocado. El componente llama al hook DOS veces, en este orden: pedido
  // y luego descarte (ver `MissingBulkActions`).
  useActionStateMock.mockReset();
  useActionStateMock
    .mockReturnValueOnce([order, vi.fn(), false])
    .mockReturnValueOnce([discard, vi.fn(), false]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockActionStates(IDLE, IDLE);
});

const MARKER_TEXT = "Marcador de la lista real";

function renderBar(eligibleIds: string[]): string {
  return renderToStaticMarkup(
    createElement(
      MissingBulkActions,
      { eligibleIds },
      createElement("p", null, MARKER_TEXT),
    ),
  );
}

// --------------------------------------------------------------------------
// `MissingBulkActions` dejó de ser una lista: ahora es una BARRA que recibe la
// lista real como `children` y no dibuja ni una fila propia. Estos tests
// prueban el contrato de la barra en AISLAMIENTO; la composición real con
// `MissingList` (y la guarda anti-duplicación de la pantalla completa) vive en
// `missing-list.render.test.ts`, porque ahí es donde se puede afirmar sobre el
// conteo real de un faltante en toda la pantalla.
// --------------------------------------------------------------------------
describe("MissingBulkActions · sin nada elegible", () => {
  it("no dibuja la barra, pero renderiza igual la lista real que le pasan como children", () => {
    const html = renderBar([]);

    expect(html).toContain(MARKER_TEXT);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Seleccionar todos");
  });
});

describe("MissingBulkActions · con elegibles", () => {
  it("arma un único <form> con el id compartido", () => {
    const html = renderBar(["a", "b"]);

    expect((html.match(/<form/g) ?? []).length).toBe(1);
    expect(html).toContain(`id="${MISSING_BULK_FORM_ID}"`);
  });

  it("nunca dibuja su propia copia de la lista: la lista real llega y se muestra tal cual, una sola vez", () => {
    const html = renderBar(["a", "b"]);

    expect((html.match(new RegExp(MARKER_TEXT, "g")) ?? []).length).toBe(1);
  });

  it("la lista real (children) queda fuera del <form>, no anidada dentro", () => {
    const html = renderBar(["a", "b"]);

    const formClose = html.indexOf("</form>");
    const markerAt = html.indexOf(MARKER_TEXT);

    expect(formClose).toBeGreaterThan(-1);
    expect(markerAt).toBeGreaterThan(formClose);
  });

  it("cuenta el total elegible en 'Seleccionar todos'", () => {
    const html = renderBar(["a", "b", "c"]);

    expect(html).toContain("Seleccionar todos (3)");
  });

  it("ofrece las dos acciones con sus dos textos, nunca un OK ambiguo", () => {
    const html = renderBar(["a"]);

    expect(html).toContain("Ya lo pedí");
    expect(html).toContain("Descartar");
  });

  it("conserva el campo de motivo dentro del único formulario", () => {
    const html = renderBar(["a"]);

    const formOpen = html.indexOf(`id="${MISSING_BULK_FORM_ID}"`);
    const formClose = html.indexOf("</form>");
    const reasonAt = html.indexOf('name="reason"');

    expect(reasonAt).toBeGreaterThan(formOpen);
    expect(reasonAt).toBeLessThan(formClose);
  });
});

describe("MissingBulkActions · contrato de error/éxito", () => {
  it("surfaces el rechazo del pedido rápido", () => {
    const message = "Este faltante ya fue pedido.";
    mockActionStates({ error: message, ok: false }, IDLE);

    const html = renderBar(["a"]);

    expect(html).toContain('role="alert"');
    expect(html).toContain(message);
  });

  it("surfaces el éxito del pedido rápido", () => {
    mockActionStates({ error: null, ok: true }, IDLE);

    const html = renderBar(["a"]);

    expect(html).toContain('role="status"');
    expect(html).toContain("Marcados como pedidos");
  });

  it("surfaces el rechazo del descarte", () => {
    const message = "Ninguno de los faltantes elegidos seguía abierto.";
    mockActionStates(IDLE, { error: message, ok: false });

    const html = renderBar(["a"]);

    expect(html).toContain('role="alert"');
    expect(html).toContain(message);
  });

  it("surfaces el éxito del descarte", () => {
    mockActionStates(IDLE, { error: null, ok: true });

    const html = renderBar(["a"]);

    expect(html).toContain('role="status"');
    expect(html).toContain("Faltantes descartados");
  });

  it("no dibuja ninguna alerta mientras ninguna acción respondió", () => {
    mockActionStates(IDLE, IDLE);

    const html = renderBar(["a"]);

    expect(html).not.toContain('role="alert"');
  });
});

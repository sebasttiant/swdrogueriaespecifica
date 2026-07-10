import { beforeEach, describe, expect, it, vi } from "vitest";

// `useActionState` es lo que trae el `{ ok, error }` de la Server Action al
// render. Lo mockeamos para poder fijar el estado devuelto y afirmar que el
// rechazo LLEGA A LA PANTALLA — antes los formularios lo descartaban.
const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

// Las Server Actions no corren en el render: solo tienen que existir para que
// `useActionState` las reciba. Mockearlas evita arrastrar "use server" y
// next/cache al entorno de test.
vi.mock("@/server/actions/pending.actions", () => ({
  deliverPendingAction: vi.fn(),
  cancelPendingAction: vi.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PendingListItem } from "@/server/repositories/pending.repository";

import { PendingList } from "./pending-list";

type ActionState = { error: string | null; ok: boolean };

const IDLE: ActionState = { error: null, ok: false };

function mockActionState(state: ActionState, isPending = false) {
  useActionStateMock.mockReturnValue([state, vi.fn(), isPending]);
}

function pending(overrides: Partial<PendingListItem> = {}): PendingListItem {
  return {
    id: "pend-1",
    quantity: 10,
    status: "PARCIAL",
    promisedAt: new Date("2026-07-10T18:00:00.000Z"),
    customerName: null,
    note: null,
    createdAt: new Date("2026-07-09T10:00:00.000Z"),
    deliveredQuantity: 4,
    product: { id: "prod-1", name: "Paracetamol", code: "P-001", unit: "unidad" },
    ...overrides,
  };
}

function renderList(
  props: Partial<{ canDeliver: boolean; canCancel: boolean; items: PendingListItem[] }> = {},
): string {
  return renderToStaticMarkup(
    createElement(PendingList, {
      items: props.items ?? [pending()],
      nextCursor: null,
      canDeliver: props.canDeliver ?? true,
      canCancel: props.canCancel ?? true,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockActionState(IDLE);
});

describe("PendingList · action error contract", () => {
  it("surfaces the delivery rejection returned by the server action", () => {
    const message = "La cantidad supera lo que resta por entregar.";
    mockActionState({ error: message, ok: false });

    const html = renderList({ canCancel: false });

    expect(html).toContain('role="alert"');
    expect(html).toContain(message);
  });

  it("surfaces the cancellation rejection returned by the server action", () => {
    const message = "No se puede cancelar un pendiente ya entregado.";
    mockActionState({ error: message, ok: false });

    const html = renderList({ canDeliver: false });

    expect(html).toContain('role="alert"');
    expect(html).toContain(message);
  });

  it("renders no alert while the action has not rejected", () => {
    const html = renderList();

    expect(html).not.toContain('role="alert"');
  });

  it("wires both forms to the stateful actions, not to fire-and-forget wrappers", () => {
    renderList();

    // Una llamada a `useActionState` por formulario: entrega y cancelación.
    // Un wrapper `Promise<void>` no podría alimentar este hook.
    expect(useActionStateMock).toHaveBeenCalledTimes(2);
  });
});

describe("PendingList · capability gating and delivery bounds", () => {
  it("caps the delivery quantity at what is left and pre-fills it", () => {
    const html = renderList({ canCancel: false });

    // 10 pedidos - 4 entregados = 6 restantes. `max`/`value` son ayuda del
    // navegador; el límite real lo impone el service bajo el lock de fila.
    expect(html).toMatch(/id="quantity-pend-1"[^>]*max="6"/);
    expect(html).toMatch(/id="quantity-pend-1"[^>]*value="6"/);
  });

  it("renders only the granted controls", () => {
    expect(renderList({ canDeliver: true, canCancel: false })).not.toContain("Cancelar");
    expect(renderList({ canDeliver: false, canCancel: true })).not.toContain("Entregar");

    const both = renderList();
    expect(both).toContain("Entregar");
    expect(both).toContain("Cancelar");
  });

  it("hides both controls on a closed pending", () => {
    const html = renderList({ items: [pending({ status: "ENTREGADO", deliveredQuantity: 10 })] });

    expect(html).not.toContain("Entregar");
    expect(html).not.toContain("Cancelar");
  });

  it("disables the controls while the action is in flight", () => {
    mockActionState(IDLE, true);

    const html = renderList();

    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toMatch(/id="quantity-pend-1"[^>]*disabled/);
  });
});

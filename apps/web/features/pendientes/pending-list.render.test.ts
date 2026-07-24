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
  updatePendingManagementStatusAction: vi.fn(),
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
    zone: null,
    totalAmount: null,
    paidAmount: 0,
    createdAt: new Date("2026-07-09T10:00:00.000Z"),
    deliveredQuantity: 4,
    product: { id: "prod-1", name: "Paracetamol", code: "P-001", unit: "unidad" },
    ...overrides,
  };
}

function renderList(
  props: Partial<{
    canDeliver: boolean;
    canCancel: boolean;
    canManageStatus: boolean;
    items: PendingListItem[];
    nextCursor: string | null;
    scope: "active" | "history";
  }> = {},
): string {
  return renderToStaticMarkup(
    createElement(PendingList, {
      items: props.items ?? [pending()],
      nextCursor: props.nextCursor ?? null,
      canDeliver: props.canDeliver ?? true,
      canCancel: props.canCancel ?? true,
      canManageStatus: props.canManageStatus ?? false,
      scope: props.scope ?? "active",
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockActionState(IDLE);
});

describe("PendingList · scope-aware pagination", () => {
  // Si el link "Ver más" solo llevara el cursor, paginar dentro del historial
  // devolvería al usuario a la vista activa sin avisar: la página siguiente se
  // resolvería con el scope por defecto y mostraría otro conjunto de filas.
  it("carries the history scope into the next-page link", () => {
    const html = renderList({ nextCursor: "cursor-2", scope: "history" });

    expect(html).toContain("scope=history");
    expect(html).toContain("cursor=cursor-2");
  });

  it("omits the scope from the next-page link in the default active view", () => {
    const html = renderList({ nextCursor: "cursor-2", scope: "active" });

    expect(html).toContain("cursor=cursor-2");
    expect(html).not.toContain("scope=");
  });
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

describe("PendingList · estado de gestión (Mejora 2)", () => {
  // El vendedor (sin autoridad de compras) NUNCA ve el selector, ni siquiera en
  // un pendiente que sí lo admitiría.
  it("hides the management selector from users without purchasing authority", () => {
    const html = renderList({
      canManageStatus: false,
      items: [pending({ status: "PENDIENTE", deliveredQuantity: 0 })],
    });

    expect(html).not.toContain("Estado de gestión");
    expect(html).not.toContain('name="status"');
  });

  it("shows the four management options to purchasing (gerencia) on an open pending", () => {
    const html = renderList({
      canManageStatus: true,
      items: [pending({ status: "PENDIENTE", deliveredQuantity: 0 })],
    });

    expect(html).toContain("Estado de gestión");
    expect(html).toContain('name="status"');
    expect(html).toContain("Solicitado");
    expect(html).toContain("En búsqueda");
    expect(html).toContain("Cotizando");
    expect(html).toContain("Agotado");
  });

  // PARCIAL ya tiene una entrega en curso: la gestión no aplica ni para gerencia.
  it("does not show the selector once the pending entered delivery (PARCIAL)", () => {
    const html = renderList({
      canManageStatus: true,
      items: [pending({ status: "PARCIAL", deliveredQuantity: 4 })],
    });

    expect(html).not.toContain("Estado de gestión");
  });

  it("does not show the selector on a closed pending", () => {
    const html = renderList({
      canManageStatus: true,
      items: [pending({ status: "ENTREGADO", deliveredQuantity: 10 })],
    });

    expect(html).not.toContain("Estado de gestión");
  });

  // Si el pendiente ya está en un estado de gestión, el selector lo preselecciona.
  it("preselects the current management status", () => {
    const html = renderList({
      canManageStatus: true,
      items: [pending({ status: "COTIZANDO", deliveredQuantity: 0 })],
    });

    expect(html).toMatch(/value="COTIZANDO"[^>]*selected/);
  });
});

describe("PendingList · seguimiento del cliente", () => {
  it("muestra la zona junto al cliente", () => {
    const html = renderList({
      items: [pending({ customerName: "Ana Pérez", zone: "Norte" })],
    });

    expect(html).toContain("Ana Pérez");
    expect(html).toContain("Norte");
  });

  // El saldo es lo que el operador tiene que COBRAR al entregar: va en la
  // tarjeta, no escondido detrás de un badge.
  it("muestra abono, total y saldo cuando el cliente abonó parte", () => {
    const html = renderList({
      items: [pending({ totalAmount: 50_000, paidAmount: 20_000 })],
    });

    // Los tres números tienen que estar: lo abonado, lo acordado y lo que falta.
    expect(html).toMatch(/Abonó[^<]*20\.000/);
    expect(html).toMatch(/de[^<]*50\.000/);
    expect(html).toMatch(/saldo[^<]*30\.000/);
  });

  it("marca como Pagado cuando el abono cubre el total", () => {
    const html = renderList({
      items: [pending({ totalAmount: 50_000, paidAmount: 50_000 })],
    });

    expect(html).toContain("Pagado");
    // Ya no hay nada que cobrar: no se anuncia un saldo.
    expect(html).not.toMatch(/saldo/i);
  });

  // Producto por cotizar: hay plata del cliente pero no un total acordado.
  it("nunca dice Pagado sin un total acordado", () => {
    const html = renderList({
      items: [pending({ totalAmount: null, paidAmount: 99_000 })],
    });

    expect(html).toContain("valor total sin acordar");
    expect(html).not.toContain(">Pagado<");
  });

  // Sin abono no se ensucia la tarjeta con un badge gris en cada fila.
  it("no muestra badge ni línea de pago cuando no hubo abono", () => {
    const html = renderList({ items: [pending({ totalAmount: null, paidAmount: 0 })] });

    expect(html).not.toContain("Abonó");
    expect(html).not.toContain(">Pagado<");
  });
});

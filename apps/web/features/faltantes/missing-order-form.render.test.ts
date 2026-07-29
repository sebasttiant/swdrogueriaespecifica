import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

vi.mock("@/server/actions/missing-item.actions", () => ({
  orderMissingItemAction: vi.fn(),
}));

import { MissingOrderForm } from "./missing-order-form";

const SUPPLIERS = [
  { id: "sup-1", name: "Distribuidora Norte" },
  { id: "sup-2", name: "Droguería Central" },
];

type ActionState = { error: string | null; ok: boolean };

const IDLE: ActionState = { error: null, ok: false };

function mockActionState(state: ActionState, isPending = false) {
  useActionStateMock.mockReturnValue([state, vi.fn(), isPending]);
}

function render(
  props: Partial<{
    suppliers: { id: string; name: string }[];
    canCreateSupplier: boolean;
    defaultOpen: boolean;
    neededQuantity: number | null;
  }> = {},
): string {
  return renderToStaticMarkup(
    createElement(MissingOrderForm, {
      id: "missing-1",
      suppliers: props.suppliers ?? SUPPLIERS,
      canCreateSupplier: props.canCreateSupplier ?? true,
      defaultOpen: props.defaultOpen ?? false,
      neededQuantity: props.neededQuantity === undefined ? 3 : props.neededQuantity,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockActionState(IDLE);
});

describe("MissingOrderForm · collapsed by default", () => {
  // En una cola operativa desde celular, un formulario abierto por fila empuja
  // los faltantes accionables fuera de la pantalla. Colapsado, la fila solo
  // ofrece el disparador.
  it("shows only the Pedir trigger, with no supplier fields mounted", () => {
    const html = render();

    expect(html).toContain("Pedir");
    expect(html).toContain('name="missingItemId" value="missing-1"');
    expect(html).not.toContain('name="supplierId"');
    expect(html).not.toContain('name="name"');
    expect(html).not.toContain('name="phone"');
    expect(html).not.toContain("Cancelar");
  });

  // El rechazo del server llega en el estado de `useActionState`, que sobrevive
  // al cierre del formulario: si no se viera, el pedido fallaría en silencio.
  it("keeps a server rejection visible while collapsed", () => {
    mockActionState({ error: "Este faltante ya fue pedido.", ok: false });

    const html = render();

    expect(html).toContain('role="alert"');
    expect(html).toContain("Este faltante ya fue pedido.");
  });
});

describe("MissingOrderForm · supplier branch", () => {
  it("offers a supplier selector when suppliers exist", () => {
    const html = render({ defaultOpen: true });

    expect(html).toContain('name="supplierId"');
    expect(html).toContain('value="sup-1"');
    expect(html).toContain("Distribuidora Norte");
    expect(html).toContain("Cancelar");
  });

  // La invariante crítica: el schema rechaza un payload con `supplierId` Y datos
  // de proveedor nuevo. Solo se montan los inputs de la rama activa, así el
  // FormData NUNCA puede llevar las dos ramas a la vez.
  it("does not mount the new-supplier inputs while the existing-supplier branch is active", () => {
    const html = render({ defaultOpen: true });

    expect(html).toContain('name="supplierId"');
    expect(html).not.toContain('name="name"');
    expect(html).not.toContain('name="phone"');
  });

  // Sin proveedores cargados todavía, la única rama posible es crear uno nuevo.
  it("falls back to the new-supplier branch when there is no supplier to choose", () => {
    const html = render({ defaultOpen: true, suppliers: [] });

    expect(html).toContain('name="name"');
    expect(html).not.toContain('name="supplierId"');
  });

  // Quien puede pedir pero NO crear proveedores nunca debe ver la rama de alta:
  // el servidor se la rechazaría con `canManageSuppliers`.
  it("never offers the new-supplier branch without the capability to create one", () => {
    const html = render({ defaultOpen: true, canCreateSupplier: false });

    expect(html).toContain('name="supplierId"');
    expect(html).not.toContain('name="name"');
    expect(html).not.toContain("Cargar proveedor nuevo");
  });

  it("offers switching to the new-supplier branch when the capability is granted", () => {
    const html = render({ defaultOpen: true });

    expect(html).toContain("Cargar proveedor nuevo");
  });
});

describe("MissingOrderForm · ordered quantity", () => {
  it("requires an ordered quantity as a positive integer input", () => {
    const html = render({ defaultOpen: true });

    expect(html).toContain('name="orderedQuantity"');
    expect(html).toContain("Cantidad a pedir");
    expect(html).toContain('type="number"');
    expect(html).toContain('required=""');
    expect(html).toContain('min="1"');
    expect(html).toContain('step="1"');
  });

  // La necesidad histórica se muestra SOLO como referencia; gerencia confirma
  // explícitamente cuánto pedir. No debe prellenar el campo en silencio.
  it("shows the recorded need as a reference without prefilling the field", () => {
    const html = render({ defaultOpen: true, neededQuantity: 7 });

    expect(html).toContain("Necesidad registrada: 7");
    // El input de cantidad a pedir no arranca con la necesidad como valor.
    expect(html).not.toContain('value="7"');
  });

  it("does not present the manual quantity sentinel as a recorded need", () => {
    const html = render({ defaultOpen: true, neededQuantity: null });

    expect(html).toContain("Definí la cantidad a pedir según la necesidad actual.");
    expect(html).not.toContain("Necesidad registrada:");
  });

  it("mounts the quantity field only when the form is open", () => {
    const html = render();

    expect(html).not.toContain('name="orderedQuantity"');
  });
});

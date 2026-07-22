import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

vi.mock("@/server/actions/missing-item.actions", () => ({
  createMissingItemAction: vi.fn(),
  searchActiveProductsForMissingItemAction: vi.fn(),
}));

import { MissingCreateForm } from "./missing-create-form";

type ActionState = { error: string | null; ok: boolean };

const IDLE: ActionState = { error: null, ok: false };

function mockActionState(state: ActionState, isPending = false) {
  useActionStateMock.mockReturnValue([state, vi.fn(), isPending]);
}

function render(props: Partial<{ defaultOpen: boolean }> = {}): string {
  return renderToStaticMarkup(
    createElement(MissingCreateForm, {
      defaultOpen: props.defaultOpen ?? false,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockActionState(IDLE);
});

describe("MissingCreateForm", () => {
  it("is collapsed by default behind the Nuevo faltante trigger", () => {
    const html = render();

    expect(html).toContain("Nuevo faltante");
    expect(html).not.toContain('name="productId"');
    expect(html).not.toContain('name="quantity"');
    expect(html).not.toContain('name="note"');
  });

  it("renders an empty searchable selector instead of serializing the catalog when opened", () => {
    const html = render({ defaultOpen: true });

    expect(html).toContain('name="productId"');
    expect(html).toContain("Buscá por nombre o código");
    expect(html).toContain("Buscar producto");
    expect(html).not.toContain("Paracetamol (PAR-1)");
    expect(html).toContain('name="quantity"');
    expect(html).toContain('name="note"');
    expect(html).not.toContain("Producto (manual)");
    expect(html).not.toContain("manualName");
  });

  it("does not announce an empty result set before any search ran", () => {
    const html = render({ defaultOpen: true });

    expect(html).not.toContain("Sin resultados para esa búsqueda.");
    expect(html).not.toContain("No se pudo buscar productos. Reintentá.");
    expect(html).not.toContain("Ver más resultados");
    expect(html).not.toContain("Seleccionado:");
    expect(html).toContain('aria-busy="false"');
  });

  it("submits an empty productId until a catalog product is selected", () => {
    const html = render({ defaultOpen: true });

    expect(html).toContain('name="productId" value=""');
  });

  it("surfaces server action errors while opened", () => {
    mockActionState({ error: "No se pudo registrar el faltante. Intentá de nuevo.", ok: false });

    const html = render({ defaultOpen: true });

    expect(html).toContain('role="alert"');
    expect(html).toContain("No se pudo registrar el faltante. Intentá de nuevo.");
  });
});

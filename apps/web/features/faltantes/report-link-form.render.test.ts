import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

// Las Server Actions no corren en el render: solo tienen que existir para que
// `useActionState` las reciba y para que el buscador esté cableado.
vi.mock("@/server/actions/missing-report.actions", () => ({
  linkMissingReportToProductAction: vi.fn(),
}));
vi.mock("@/server/actions/missing-item.actions", () => ({
  searchActiveProductsForMissingItemAction: vi.fn(),
}));

import { ReportLinkForm } from "./report-link-form";

type ActionState = { error: string | null; ok: boolean; missingItemId?: string };

const IDLE: ActionState = { error: null, ok: false };

function mockActionState(state: ActionState, isPending = false) {
  useActionStateMock.mockReturnValue([state, vi.fn(), isPending]);
}

function render(
  props: Partial<{ reportIds: string[]; defaultOpen: boolean }> = {},
): string {
  return renderToStaticMarkup(
    createElement(ReportLinkForm, {
      reportIds: props.reportIds ?? ["r1", "r2"],
      defaultOpen: props.defaultOpen ?? false,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockActionState(IDLE);
});

describe("ReportLinkForm · collapsed", () => {
  it("offers only the Vincular producto trigger, with no search mounted", () => {
    const html = render();

    expect(html).toContain("Vincular producto");
    expect(html).not.toContain("Buscá por nombre o código");
    expect(html).not.toContain("Confirmar vínculo");
  });

  // El resultado sobrevive al colapso: si no se viera, gerencia no sabría si el
  // faltante quedó creado.
  it("keeps the success confirmation visible while collapsed", () => {
    mockActionState({ error: null, ok: true, missingItemId: "missing-1" });

    const html = render();

    expect(html).toContain('role="status"');
    expect(html).toContain("Faltante creado");
  });

  it("keeps a server error visible while collapsed", () => {
    mockActionState({ error: "El producto no existe o está inactivo.", ok: false });

    const html = render();

    expect(html).toContain('role="alert"');
    expect(html).toContain("El producto no existe o está inactivo.");
  });
});

describe("ReportLinkForm · open", () => {
  it("mounts the catalog search", () => {
    const html = render({ defaultOpen: true });

    expect(html).toContain("Buscá por nombre o código");
    expect(html).toContain("Buscar producto");
  });

  // El contrato con la acción: TODOS los reportes del grupo viajan, para que el
  // vínculo sea del grupo entero y no de uno solo.
  it("submits every report id of the group", () => {
    const html = render({ reportIds: ["r1", "r2", "r3"], defaultOpen: true });

    expect(html).toContain('name="reportIds" value="r1"');
    expect(html).toContain('name="reportIds" value="r2"');
    expect(html).toContain('name="reportIds" value="r3"');
  });

  it("submits an empty productId until a product is picked", () => {
    const html = render({ defaultOpen: true });

    expect(html).toContain('name="productId" value=""');
  });

  // Sin producto elegido el confirmar se ve pero no se puede tocar: muestra el
  // paso siguiente sin permitir disparar la acción con un productId vacío.
  it("keeps confirm visible but disabled before a product is selected", () => {
    const html = render({ defaultOpen: true });

    expect(html).toContain("Confirmar vínculo");
    expect(html).toMatch(/<button type="submit"[^>]*\bdisabled\b/);
  });

  it("does not offer quantity, supplier or note fields", () => {
    const html = render({ defaultOpen: true });

    expect(html).not.toContain('name="quantity"');
    expect(html).not.toContain('name="orderedQuantity"');
    expect(html).not.toContain('name="supplierId"');
    expect(html).not.toContain('name="note"');
  });
});

describe("ReportLinkForm · action states", () => {
  it("disables the trigger and announces progress while linking", () => {
    mockActionState(IDLE, true);

    const html = render({ defaultOpen: true });

    expect(html).toContain("Vinculando…");
    expect(html).toMatch(/<button[^>]*\bdisabled\b/);
  });

  it("shows the success message pointing management to the faltantes queue", () => {
    mockActionState({ error: null, ok: true, missingItemId: "missing-1" });

    const html = render({ defaultOpen: true });

    expect(html).toContain('role="status"');
    expect(html).toContain(
      "Faltante creado. Gerencia puede definir cantidad y pedirlo en /faltantes.",
    );
  });

  it("surfaces the action's own rejection message", () => {
    mockActionState({
      error: "Estos reportes ya fueron revisados. Actualizá la cola.",
      ok: false,
    });

    const html = render({ defaultOpen: true });

    expect(html).toContain('role="alert"');
    expect(html).toContain("Estos reportes ya fueron revisados. Actualizá la cola.");
  });

  it("shows no feedback while idle", () => {
    const html = render({ defaultOpen: true });

    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="status"');
  });

  // Un mensaje largo del servidor no debe empujar la tarjeta fuera de pantalla.
  it("lets long messages wrap instead of overflowing", () => {
    mockActionState({ error: "x".repeat(140), ok: false });

    const html = render({ defaultOpen: true });

    expect(html).toContain("break-words");
  });
});

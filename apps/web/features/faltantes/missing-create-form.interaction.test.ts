/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMissingItemAction: vi.fn(),
  searchActiveProductsForMissingItemAction: vi.fn(),
}));

vi.mock("@/server/actions/missing-item.actions", () => ({
  createMissingItemAction: mocks.createMissingItemAction,
  searchActiveProductsForMissingItemAction:
    mocks.searchActiveProductsForMissingItemAction,
}));

import { MissingCreateForm } from "./missing-create-form";

describe("MissingCreateForm · catalog selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchActiveProductsForMissingItemAction.mockResolvedValue({
      items: [{ id: "prod-amoxi", name: "Amoxicilina", code: "AMO-1" }],
      nextCursor: null,
    });
    mocks.createMissingItemAction.mockResolvedValue({ error: null, ok: true });
  });

  afterEach(cleanup);

  it("searches, selects a visible catalog option, enables creation, and submits its productId", async () => {
    const user = userEvent.setup();
    const { container } = render(createElement(MissingCreateForm, { defaultOpen: true }));

    await user.type(screen.getByRole("searchbox"), "amoxi");
    await user.click(screen.getByRole("button", { name: "Buscar producto" }));

    const option = await screen.findByRole("option", { name: "Amoxicilina (AMO-1)" });
    expect(screen.getByRole("button", { name: "Crear faltante" })).toHaveProperty(
      "disabled",
      true,
    );

    await user.click(option);

    const submit = screen.getByRole("button", { name: "Crear faltante" });
    expect(submit).toHaveProperty("disabled", false);
    expect((container.querySelector('input[name="productId"]') as HTMLInputElement).value).toBe(
      "prod-amoxi",
    );

    await user.click(submit);

    await waitFor(() => expect(mocks.createMissingItemAction).toHaveBeenCalledTimes(1));
    const formData = mocks.createMissingItemAction.mock.calls[0]![1] as FormData;
    expect(formData.get("productId")).toBe("prod-amoxi");
  });

  it("shows the catalog-miss guidance and keeps creation disabled without a productId", async () => {
    mocks.searchActiveProductsForMissingItemAction.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });
    const user = userEvent.setup();
    const { container } = render(createElement(MissingCreateForm, { defaultOpen: true }));

    await user.type(screen.getByRole("searchbox"), "producto inexistente");
    await user.click(screen.getByRole("button", { name: "Buscar producto" }));

    const catalogMiss = await screen.findByText(
      "No hay un producto activo en el catálogo con ese nombre o código. Verificá el catálogo o reportalo como faltante.",
    );
    expect(catalogMiss.getAttribute("role")).toBe("status");
    expect(screen.getByRole("button", { name: "Crear faltante" })).toHaveProperty(
      "disabled",
      true,
    );
    expect((container.querySelector('input[name="productId"]') as HTMLInputElement).value).toBe("");
    expect(mocks.createMissingItemAction).not.toHaveBeenCalled();
  });

  it("prevents form submission via Enter when no product is selected", async () => {
    const user = userEvent.setup();
    render(createElement(MissingCreateForm, { defaultOpen: true }));

    // Escribimos en el campo de nota (no en el de búsqueda) y presionamos Enter.
    // Sin la corrección, esto enviaría el formulario vacío.
    await user.type(screen.getByPlaceholderText("Detalle operativo"), "test note{Enter}");

    // La acción NO debió ser llamada: no hay producto seleccionado.
    expect(mocks.createMissingItemAction).not.toHaveBeenCalled();
  });
});

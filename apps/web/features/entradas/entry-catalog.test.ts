/** @vitest-environment jsdom */
import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/server/actions/entry.actions", () => ({
  createInventoryEntryAction: vi.fn(),
}));
vi.mock("@/server/actions/product-search.actions", () => ({
  searchEntryProductsAction: vi.fn(),
}));
import { searchEntryProductsAction } from "@/server/actions/product-search.actions";
import { EntryForm, type ProductOption } from "./entry-form";
const target: ProductOption = {
  id: "183",
  name: "Vichy",
  code: "internal",
  orionCode: "OR-183",
  laboratoryName: "Orion lab",
  unit: "caja",
  identityVersion: 4,
  catalogVersion: 7,
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("ignores an obsolete response after the query changes", async () => {
  let resolveOld!: (products: ProductOption[]) => void;
  vi.mocked(searchEntryProductsAction)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce([{ ...target, id: "new", name: "Nuevo" }]);
  const user = userEvent.setup();
  render(
    createElement(EntryForm, {
      products: [target],
      selectedProductId: target.id,
    }),
  );
  const input = screen.getByLabelText("Buscar producto");
  await user.type(input, "old");
  await user.click(screen.getByRole("button", { name: "Buscar" }));
  await user.clear(input);
  await user.type(input, "new");
  await user.click(screen.getByRole("button", { name: "Buscar" }));
  await screen.findByRole("option", { name: /Nuevo/ });
  await act(async () =>
    resolveOld([{ ...target, id: "old", name: "Obsoleto" }]),
  );
  expect(screen.queryByRole("option", { name: /Obsoleto/ })).toBeNull();
  expect(screen.getByRole("option", { name: /Nuevo/ })).toBeTruthy();
});

it("ignores an obsolete error without clearing the current loading state", async () => {
  let rejectOld!: (error: Error) => void;
  let resolveCurrent!: (products: ProductOption[]) => void;
  vi.mocked(searchEntryProductsAction)
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOld = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCurrent = resolve;
        }),
    );
  const user = userEvent.setup();
  render(
    createElement(EntryForm, {
      products: [target],
      selectedProductId: target.id,
    }),
  );
  const input = screen.getByLabelText("Buscar producto");
  await user.type(input, "old");
  await user.click(screen.getByRole("button", { name: "Buscar" }));
  await user.clear(input);
  await user.type(input, "new");
  await user.click(screen.getByRole("button", { name: "Buscar" }));
  await act(async () => rejectOld(new Error("obsolete")));
  expect(screen.queryByText(/No se pudo buscar/)).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Buscando…" })
      .disabled,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Registrar entrada" })
      .disabled,
  ).toBe(true);
  await act(async () => resolveCurrent([]));
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Buscar" }).disabled,
  ).toBe(false);
});

it("preserves the draft after a search error and permits retry", async () => {
  vi.mocked(searchEntryProductsAction)
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce([]);
  const user = userEvent.setup();
  const { container } = render(
    createElement(EntryForm, {
      products: [target],
      selectedProductId: target.id,
      selectedQuantity: 12,
    }),
  );
  await user.type(screen.getByLabelText("Buscar producto"), "Vichy");
  await user.click(screen.getByRole("button", { name: "Buscar" }));
  await screen.findByText(/No se pudo buscar/);
  const data = new FormData(container.querySelector("form")!);
  expect(data.get("productId")).toBe(target.id);
  expect(data.get("quantity")).toBe("12");
  expect(data.get("expectedCatalogVersion")).toBe("7");
  await user.click(screen.getByRole("button", { name: "Buscar" }));
  await screen.findByText(/No se encontraron productos activos/);
});

it("keeps the selected snapshot when search returns newer versions", async () => {
  vi.mocked(searchEntryProductsAction).mockResolvedValue([
    { ...target, identityVersion: 99, orionCode: "NEW" },
  ]);
  const user = userEvent.setup();
  const { container } = render(
    createElement(EntryForm, {
      products: [target],
      selectedProductId: target.id,
    }),
  );
  await user.type(screen.getByLabelText("Buscar producto"), "Vichy");
  await user.click(screen.getByRole("button", { name: "Buscar" }));
  await screen.findByText(/Hasta 20 resultados/);
  const data = new FormData(container.querySelector("form")!);
  expect(data.get("expectedIdentityVersion")).toBe("4");
  expect(data.get("displayedSku")).toBe("OR-183");
});
it("keeps selection and quantity when no active matches are found", async () => {
  vi.mocked(searchEntryProductsAction).mockResolvedValue([]);
  const user = userEvent.setup();
  const { container } = render(
    createElement(EntryForm, {
      products: [target],
      selectedProductId: target.id,
      selectedQuantity: 12,
    }),
  );
  await user.type(screen.getByLabelText("Buscar producto"), "unknown");
  await user.click(screen.getByRole("button", { name: "Buscar" }));
  await screen.findByText(/No se encontraron productos activos/);
  const data = new FormData(container.querySelector("form")!);
  expect(data.get("productId")).toBe("183");
  expect(data.get("quantity")).toBe("12");
});
it("searches beyond the initial page and submits the selected snapshot", async () => {
  vi.mocked(searchEntryProductsAction).mockResolvedValue([target]);
  const user = userEvent.setup();
  const { container } = render(createElement(EntryForm, { products: [] }));
  await user.type(screen.getByLabelText("Buscar producto"), "Vichy");
  await user.click(screen.getByRole("button", { name: "Buscar" }));
  await screen.findByRole("option", { name: /Vichy/ });
  await user.selectOptions(screen.getByLabelText("Producto"), "183");
  const data = new FormData(container.querySelector("form")!);
  expect(searchEntryProductsAction).toHaveBeenCalledWith("Vichy");
  expect(data.get("productId")).toBe("183");
  expect(data.get("expectedIdentityVersion")).toBe("4");
  expect(data.get("expectedCatalogVersion")).toBe("7");
});

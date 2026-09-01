/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

vi.mock("@/server/actions/product.actions", () => ({ updateProductAction: vi.fn() }));

import { ProductEditForm, type EditableProduct } from "./product-edit-form";

// --------------------------------------------------------------------------
// El formulario ABIERTO.
//
// Se abre de verdad en vez de mirar el HTML inicial, y la razón es concreta:
// el formulario arranca plegado, así que afirmar "no hay campo de stock" sobre
// el render inicial pasa porque no hay NINGÚN campo. Sería una prueba en verde
// que no prueba nada — la peor clase.
// --------------------------------------------------------------------------

const PRODUCTO: EditableProduct = {
  id: "prod-1",
  code: "MED-001",
  name: "Dolex Niños",
  unit: "Frasco",
  minStock: 5,
  reorderQty: 20,
  active: true,
  laboratoryId: "lab-1",
  laboratoryName: "Genfar",
  catalogVersion: 3,
};

async function abrir(product: EditableProduct = PRODUCTO) {
  const user = userEvent.setup();
  const view = render(createElement(ProductEditForm, { product }));
  await user.click(screen.getByRole("button", { name: "Editar producto" }));
  return { user, container: view.container };
}

function campo(container: HTMLElement, name: string): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(`[name="${name}"]`);
}

beforeEach(() => {
  vi.clearAllMocks();
  useActionStateMock.mockReturnValue([{ error: null, ok: false }, vi.fn(), false]);
});

afterEach(cleanup);

describe("editar producto · plegado", () => {
  it("arranca cerrado: la pantalla se abre para MIRAR, no para editar", () => {
    const { container } = render(createElement(ProductEditForm, { product: PRODUCTO }));

    expect(screen.getByRole("button", { name: "Editar producto" })).toBeTruthy();
    expect(campo(container, "name")).toBeNull();
  });
});

describe("editar producto · abierto, lo que se puede cambiar", () => {
  it("trae los valores actuales cargados", async () => {
    const { container } = await abrir();

    expect(campo(container, "name")?.value).toBe("Dolex Niños");
    expect(campo(container, "code")?.value).toBe("MED-001");
    expect(campo(container, "unit")?.value).toBe("Frasco");
    expect(campo(container, "minStock")?.value).toBe("5");
    expect(campo(container, "reorderQty")?.value).toBe("20");
  });

  it("el id del producto viaja para que la acción sepa cuál editar", async () => {
    const { container } = await abrir();

    expect(campo(container, "id")?.value).toBe("prod-1");
  });

  it("dice Presentación, que es la palabra del mostrador", async () => {
    await abrir();

    expect(screen.getByLabelText("Presentación")).toBeTruthy();
  });

  it("la casilla de activo refleja el estado real", async () => {
    const { container } = await abrir();
    expect(campo(container, "active")?.checked).toBe(true);

    cleanup();
    const otro = await abrir({ ...PRODUCTO, active: false });
    expect(campo(otro.container, "active")?.checked).toBe(false);
  });

  it("el laboratorio llega ya elegido, no en blanco", async () => {
    const { container } = await abrir();

    expect(campo(container, "laboratoryId")?.value).toBe("lab-1");
  });
});

// --------------------------------------------------------------------------
// La prueba de fondo del módulo, ahora sobre el formulario ABIERTO.
// --------------------------------------------------------------------------
describe("editar producto · lo que NO se puede tocar desde acá", () => {
  it("no hay ningún campo de cantidad, con el formulario desplegado", async () => {
    const { container } = await abrir();

    for (const prohibido of [
      "stock",
      "quantity",
      "onHand",
      "sellableStock",
      "batchQuantity",
    ]) {
      expect(campo(container, prohibido), `apareció un campo ${prohibido}`).toBeNull();
    }
  });

  // El SKU vive en la tarjeta de identidad, que tiene control de concurrencia:
  // vincularlo cuando falta y corregirlo cuando ya existe son actos distintos.
  it("no ofrece editar el SKU ni su versión de identidad", async () => {
    const { container } = await abrir();

    expect(campo(container, "orionCode")).toBeNull();
    expect(campo(container, "identityVersion")).toBeNull();
  });

  // Si no se dice, alguien va a buscar el stock acá y no lo va a encontrar.
  it("explica en pantalla por qué el stock no está", async () => {
    await abrir();

    expect(screen.getByText(/El stock no se edita acá/)).toBeTruthy();
  });
});

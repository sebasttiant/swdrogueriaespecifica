/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updateProductAction: vi.fn() }));

vi.mock("@/server/actions/product.actions", () => ({
  updateProductAction: mocks.updateProductAction,
}));

import { ProductEditForm, type EditableProduct } from "./product-edit-form";

// --------------------------------------------------------------------------
// Un fallo NUNCA borra lo que la persona escribió.
//
// Es el mismo incidente que ya golpeó al alta de pendientes: React limpia los
// campos no controlados de un `<form action>` en cuanto la acción RESUELVE, y
// un error devuelto es una resolución. Sin eco, cada campo vuelve a su
// `defaultValue` —el valor GUARDADO— y el trabajo de corrección se pierde.
//
// Acá duele más que en un alta: quien edita un producto está corrigiendo
// varios campos a la vez contra la caja que tiene en la mano. Perderlos por un
// código duplicado obliga a tipear todo de nuevo.
//
// Se mockea la ACCIÓN y no `useActionState`, a propósito: lo que se está
// probando es el comportamiento de React al resolver, y mockear el hook lo
// taparía.
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
};

function campo(container: HTMLElement, name: string): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(`[name="${name}"]`);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("editar producto · un fallo no borra lo cargado", () => {
  it("conserva lo escrito cuando el servidor rechaza", async () => {
    mocks.updateProductAction.mockImplementation(
      (_prev: unknown, formData: FormData) => ({
        error: "Ya existe otro producto con ese código.",
        ok: false,
        values: {
          code: String(formData.get("code") ?? ""),
          name: String(formData.get("name") ?? ""),
          unit: String(formData.get("unit") ?? ""),
          minStock: String(formData.get("minStock") ?? ""),
          reorderQty: String(formData.get("reorderQty") ?? ""),
          active: formData.get("active") === "on" ? "on" : "",
        },
      }),
    );

    const user = userEvent.setup();
    const { container } = render(
      createElement(ProductEditForm, { product: PRODUCTO }),
    );
    await user.click(screen.getByRole("button", { name: "Editar producto" }));

    const nombre = campo(container, "name")!;
    await user.clear(nombre);
    await user.type(nombre, "Dolex Niños Jarabe");

    const codigo = campo(container, "code")!;
    await user.clear(codigo);
    await user.type(codigo, "MED-002");

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await screen.findByRole("alert");

    // Lo que la persona escribió, no lo que estaba guardado.
    expect(campo(container, "name")?.value).toBe("Dolex Niños Jarabe");
    expect(campo(container, "code")?.value).toBe("MED-002");
  });

  it("el formulario sigue abierto para poder corregir", async () => {
    mocks.updateProductAction.mockReturnValue({
      error: "Ya existe otro producto con ese código.",
      ok: false,
    });

    const user = userEvent.setup();
    const { container } = render(
      createElement(ProductEditForm, { product: PRODUCTO }),
    );
    await user.click(screen.getByRole("button", { name: "Editar producto" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await screen.findByRole("alert");

    expect(campo(container, "name")).not.toBeNull();
  });
});

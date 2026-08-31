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
  updatedAt: "2026-08-31T12:00:00.000Z",
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
          laboratoryId: String(formData.get("laboratoryId") ?? ""),
          laboratoryName: String(formData.get("laboratoryName") ?? ""),
          expectedUpdatedAt: String(formData.get("expectedUpdatedAt") ?? ""),
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

// --------------------------------------------------------------------------
// Las dos regresiones que encontró la revisión sobre este HEAD.
//
// Las dos nacen del mismo lugar: `useActionState` de este proyecto llama a
// `router.refresh()` ante CUALQUIER respuesta, también ante un rechazo. Así
// que después de un error el componente recibe datos FRESCOS del servidor
// mientras el formulario sigue mostrando lo que la persona escribió. Mezclar
// esas dos fuentes es lo que abre los dos agujeros.
// --------------------------------------------------------------------------
describe("editar producto · el testigo de concurrencia no se puede esquivar", () => {
  it("tras un rechazo, el reintento manda el testigo VIEJO aunque llegue uno nuevo", async () => {
    mocks.updateProductAction.mockImplementation(
      (_prev: unknown, formData: FormData) => ({
        error: "Alguien más actualizó este producto mientras lo editabas.",
        ok: false,
        submissionId: "fallo-1",
        values: {
          code: String(formData.get("code") ?? ""),
          name: String(formData.get("name") ?? ""),
          unit: String(formData.get("unit") ?? ""),
          minStock: String(formData.get("minStock") ?? ""),
          reorderQty: String(formData.get("reorderQty") ?? ""),
          laboratoryId: String(formData.get("laboratoryId") ?? ""),
          laboratoryName: String(formData.get("laboratoryName") ?? ""),
          active: "on",
          expectedUpdatedAt: String(formData.get("expectedUpdatedAt") ?? ""),
        },
      }),
    );

    const user = userEvent.setup();
    const view = render(createElement(ProductEditForm, { product: PRODUCTO }));
    await user.click(screen.getByRole("button", { name: "Editar producto" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByRole("alert");

    // Esto es lo que hace `router.refresh()`: el componente recibe el producto
    // ya modificado por la otra persona, con un `updatedAt` NUEVO.
    view.rerender(
      createElement(ProductEditForm, {
        product: { ...PRODUCTO, updatedAt: "2026-09-01T09:00:00.000Z" },
      }),
    );

    // El campo oculto tiene que seguir mandando el testigo del intento
    // fallido. Con el fresco, el reintento pasaría el control y pisaría la
    // edición ajena — el agujero que esto cierra.
    expect(campo(view.container, "expectedUpdatedAt")?.value).toBe(
      "2026-08-31T12:00:00.000Z",
    );
  });
});

describe("editar producto · el laboratorio escrito no recupera el id viejo", () => {
  it("tras un error, un nombre escrito NO vuelve pegado al laboratorio anterior", async () => {
    mocks.updateProductAction.mockImplementation(
      (_prev: unknown, formData: FormData) => ({
        error: "Revisa los datos del producto.",
        ok: false,
        submissionId: "fallo-2",
        values: {
          code: String(formData.get("code") ?? ""),
          name: String(formData.get("name") ?? ""),
          unit: String(formData.get("unit") ?? ""),
          minStock: String(formData.get("minStock") ?? ""),
          reorderQty: String(formData.get("reorderQty") ?? ""),
          // La persona escribió otro laboratorio sin elegirlo de la lista: el
          // buscador soltó la selección y mandó el id VACÍO.
          laboratoryId: "",
          laboratoryName: "Genfar",
          active: "on",
          expectedUpdatedAt: String(formData.get("expectedUpdatedAt") ?? ""),
        },
      }),
    );

    const user = userEvent.setup();
    const { container } = render(
      createElement(ProductEditForm, { product: PRODUCTO }),
    );
    await user.click(screen.getByRole("button", { name: "Editar producto" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByRole("alert");

    // Con `||`, el vacío intencional se leía como "no vino" y volvía "lab-1":
    // el buscador quedaba mostrando "Genfar" pegado al id de Bayer, y el
    // reintento guardaba el laboratorio equivocado en silencio.
    expect(campo(container, "laboratoryId")?.value).toBe("");
  });
});

// --------------------------------------------------------------------------
// Después de un guardado EXITOSO.
//
// El éxito cambia `submissionId` y NO trae eco, así que los campos se
// remontan leyendo el producto que el componente tiene en ese instante — que
// todavía es el VIEJO, porque `router.refresh()` no llegó. Cuando llega, el
// testigo (controlado) se actualiza, pero los campos no controlados NO se
// releen: quedan mostrando los valores previos al guardado junto a un testigo
// nuevo y válido.
//
// El resultado es peor que un detalle visual: apretar "Guardar cambios" otra
// vez manda esos valores viejos, pasa el control de concurrencia y REVIERTE lo
// que se acababa de guardar.
// --------------------------------------------------------------------------
describe("editar producto · tras un guardado exitoso", () => {
  it("muestra lo GUARDADO cuando llegan los datos frescos, no lo anterior", async () => {
    mocks.updateProductAction.mockReturnValue({
      error: null,
      ok: true,
      submissionId: "exito-1",
    });

    const user = userEvent.setup();
    const view = render(createElement(ProductEditForm, { product: PRODUCTO }));
    await user.click(screen.getByRole("button", { name: "Editar producto" }));

    const nombre = campo(view.container, "name")!;
    await user.clear(nombre);
    await user.type(nombre, "Dolex Niños Jarabe");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByRole("status");

    // Esto es `router.refresh()` llegando: el producto ya guardado.
    view.rerender(
      createElement(ProductEditForm, {
        product: {
          ...PRODUCTO,
          name: "Dolex Niños Jarabe",
          updatedAt: "2026-09-01T09:00:00.000Z",
        },
      }),
    );

    expect(campo(view.container, "name")?.value).toBe("Dolex Niños Jarabe");
  });

  it("el testigo y los campos describen el MISMO producto", async () => {
    mocks.updateProductAction.mockReturnValue({
      error: null,
      ok: true,
      submissionId: "exito-2",
    });

    const user = userEvent.setup();
    const view = render(createElement(ProductEditForm, { product: PRODUCTO }));
    await user.click(screen.getByRole("button", { name: "Editar producto" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByRole("status");

    view.rerender(
      createElement(ProductEditForm, {
        product: { ...PRODUCTO, minStock: 42, updatedAt: "2026-09-01T09:00:00.000Z" },
      }),
    );

    // Si el testigo es el nuevo pero los campos son los viejos, reenviar
    // revierte el guardado que acaba de ocurrir.
    expect(campo(view.container, "expectedUpdatedAt")?.value).toBe(
      "2026-09-01T09:00:00.000Z",
    );
    expect(campo(view.container, "minStock")?.value).toBe("42");
  });
});

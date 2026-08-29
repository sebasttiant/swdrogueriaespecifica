/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/actions/entry.actions", () => ({
  createInventoryEntryAction: vi.fn(),
}));

import { EntryForm, type ProductOption } from "./entry-form";

// --------------------------------------------------------------------------
// El producto que llega desde un faltante NO se vuelve a elegir.
//
// En producción había tres productos llamados "Gel Caliente Muscular", "Gel
// Muscular Caliente" y "Gel Caliente Muscular", con ids distintos. La entrada
// mostraba solo el nombre, bodega eligió uno, y la mercadería se registró contra
// un producto que ningún pendiente esperaba: el faltante no se cerró y el aviso
// nunca le llegó al vendedor.
//
// Cuando la entrada sale de la cola de bodega, la identidad ya la decidió el
// pendiente que originó el faltante. Dejar elegir de nuevo reabre exactamente
// ese error.
// --------------------------------------------------------------------------

const GEL_A: ProductOption = {
  id: "prod-a",
  name: "Gel Caliente Muscular",
  code: "PROV-a",
  orionCode: "ORN-111",
  laboratoryName: "MK",
};
const GEL_B: ProductOption = {
  id: "prod-b",
  name: "Gel Muscular Caliente",
  code: "PROV-b",
  orionCode: "ORN-222",
  laboratoryName: "Genfar",
};

function renderForm(props: Partial<Parameters<typeof EntryForm>[0]> = {}) {
  const { container } = render(
    createElement(EntryForm, { products: [GEL_A, GEL_B], ...props }),
  );
  return container.querySelector("form") as HTMLFormElement;
}

const payload = (form: HTMLFormElement) => new FormData(form);

afterEach(cleanup);

describe("EntryForm · producto fijo desde un faltante", () => {
  it("envía el productId del faltante", () => {
    const form = renderForm({ lockedProduct: GEL_A, missingItemId: "mi-1" });

    expect(payload(form).get("productId")).toBe("prod-a");
  });

  // La identidad del faltante viaja para poder trazar de dónde salió la entrada.
  it("lleva el faltante que la originó", () => {
    const form = renderForm({ lockedProduct: GEL_A, missingItemId: "mi-1" });

    expect(payload(form).get("missingItemId")).toBe("mi-1");
  });

  it("NO ofrece el selector de producto", () => {
    renderForm({ lockedProduct: GEL_A, missingItemId: "mi-1" });

    expect(screen.queryByRole("combobox", { name: /producto/i })).toBeNull();
  });

  // El campo va oculto y NO deshabilitado: un input `disabled` no entra en el
  // FormData, y la entrada se enviaría sin producto.
  it("el campo viaja aunque no se pueda editar", () => {
    const form = renderForm({ lockedProduct: GEL_A, missingItemId: "mi-1" });
    const campo = form.querySelector('input[name="productId"]') as HTMLInputElement;

    expect(campo.type).toBe("hidden");
    expect(campo.disabled).toBe(false);
  });

  it("muestra SKU y laboratorio para que se pueda cotejar la caja", () => {
    renderForm({ lockedProduct: GEL_A, missingItemId: "mi-1" });

    expect(screen.getByText(/ORN-111/)).toBeDefined();
    expect(screen.getByText(/MK/)).toBeDefined();
  });

  // Un campo bloqueado sin explicación se lee como una falla de la pantalla.
  it("dice por qué no se puede cambiar", () => {
    renderForm({ lockedProduct: GEL_A, missingItemId: "mi-1" });

    expect(screen.getByText(/no se puede cambiar/i)).toBeDefined();
  });

  it("avisa cuando el producto todavía no tiene SKU", () => {
    renderForm({
      lockedProduct: { ...GEL_A, orionCode: null },
      missingItemId: "mi-1",
    });

    expect(screen.getByText(/sin asignar/i)).toBeDefined();
  });
});

describe("EntryForm · entrada suelta", () => {
  it("sí ofrece el selector cuando no viene de un faltante", () => {
    renderForm();

    expect(screen.getByRole("combobox", { name: /producto/i })).toBeDefined();
  });

  // Lo que hacía indistinguibles a los tres "Gel": la opción mostraba el código
  // INTERNO, que no significa nada del otro lado del mostrador.
  it("distingue productos parecidos por SKU y laboratorio", () => {
    renderForm();

    expect(screen.getByRole("option", { name: /Gel Caliente Muscular — ORN-111 · MK/ })).toBeDefined();
    expect(screen.getByRole("option", { name: /Gel Muscular Caliente — ORN-222 · Genfar/ })).toBeDefined();
  });

  it("no muestra el código interno, que no identifica nada", () => {
    renderForm();

    expect(screen.queryByRole("option", { name: /PROV-a/ })).toBeNull();
  });

  it("dice 'sin SKU' en vez de dejar el hueco", () => {
    render(
      createElement(EntryForm, {
        products: [{ ...GEL_A, orionCode: null, laboratoryName: null }],
      }),
    );

    expect(screen.getByRole("option", { name: /sin SKU/ })).toBeDefined();
  });

  it("permite elegir y envía el id elegido", async () => {
    const user = userEvent.setup();
    const form = renderForm();

    await user.selectOptions(screen.getByRole("combobox", { name: /producto/i }), "prod-b");

    expect(payload(form).get("productId")).toBe("prod-b");
  });
});

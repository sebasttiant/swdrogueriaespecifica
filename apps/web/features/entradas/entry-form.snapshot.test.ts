/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// El estado de la Server Action se controla desde el test: `useActionState` de
// React se reemplaza por uno que devuelve el estado que cada caso necesita. Es
// el mismo recurso que usa `entry-form.interaction.test.ts`, y es lo que
// permite observar la pantalla DESPUES de un rechazo sin montar un servidor.
const mocks = vi.hoisted(() => ({
  estado: { error: null, ok: false } as Record<string, unknown>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useActionState: () => [mocks.estado, vi.fn(), false],
  };
});

vi.mock("@/server/actions/entry.actions", () => ({
  createInventoryEntryAction: vi.fn(),
}));

import { EntryForm, type ProductOption } from "./entry-form";

// --------------------------------------------------------------------------
// Entradas registra contra la FOTOGRAFÍA que la persona vio.
//
// La pantalla tiene que decir SKU y presentación —dos cajas del mismo
// medicamento se distinguen por ahí— y tiene que declararle al servidor las dos
// versiones que efectivamente mostró. Si declarara las de hoy, el control de
// concurrencia dejaría pasar justo la entrada que debe frenar.
// --------------------------------------------------------------------------

const FRASCO: ProductOption = {
  id: "prod-frasco",
  name: "Amoxicilina",
  code: "PROV-1",
  orionCode: "ORN-111",
  laboratoryName: "Genfar",
  unit: "frasco",
  identityVersion: 3,
  catalogVersion: 7,
};
const SOBRE: ProductOption = {
  ...FRASCO,
  id: "prod-sobre",
  code: "PROV-2",
  orionCode: "ORN-222",
  unit: "sobre",
  identityVersion: 1,
  catalogVersion: 2,
};

function renderForm(props: Partial<Parameters<typeof EntryForm>[0]> = {}) {
  const { container } = render(
    createElement(EntryForm, { products: [FRASCO, SOBRE], ...props }),
  );
  return container.querySelector("form") as HTMLFormElement;
}

const payload = (form: HTMLFormElement) => new FormData(form);

beforeEach(() => {
  mocks.estado = { error: null, ok: false };
});

afterEach(cleanup);

describe("EntryForm · qué identifica al producto en pantalla", () => {
  it("la opción dice nombre, SKU, presentación y laboratorio", () => {
    renderForm();

    expect(
      screen.getByRole("option", { name: "Amoxicilina — ORN-111 · frasco · Genfar" }),
    ).toBeTruthy();
  });

  // Dos cajas del mismo medicamento, la misma marca y el mismo SKU no se
  // distinguen sin esto.
  it("distingue dos presentaciones del mismo medicamento", () => {
    renderForm();

    expect(screen.getByRole("option", { name: /· frasco ·/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /· sobre ·/ })).toBeTruthy();
  });

  it("al elegir un producto muestra su SKU y su presentación", async () => {
    renderForm();

    await userEvent.selectOptions(screen.getByLabelText("Producto"), "prod-sobre");

    const resumen = screen.getByText(/SKU:/).textContent ?? "";
    expect(resumen).toContain("ORN-222");
    expect(resumen).toContain("sobre");
  });

  it("el producto fijo desde un faltante también muestra la presentación", () => {
    renderForm({ lockedProduct: FRASCO, missingItemId: "mi-1" });

    expect(screen.getByText(/Presentación: frasco/)).toBeTruthy();
  });
});

describe("EntryForm · el contrato que se le manda al servidor", () => {
  it("declara las dos versiones del producto elegido", async () => {
    const form = renderForm();

    await userEvent.selectOptions(screen.getByLabelText("Producto"), "prod-frasco");

    expect(payload(form).get("expectedIdentityVersion")).toBe("3");
    expect(payload(form).get("expectedCatalogVersion")).toBe("7");
  });

  it("las versiones siguen al producto que se elige", async () => {
    const form = renderForm();

    await userEvent.selectOptions(screen.getByLabelText("Producto"), "prod-sobre");

    expect(payload(form).get("expectedIdentityVersion")).toBe("1");
    expect(payload(form).get("expectedCatalogVersion")).toBe("2");
  });

  it("manda el SKU y la presentación que MOSTRÓ", async () => {
    const form = renderForm();

    await userEvent.selectOptions(screen.getByLabelText("Producto"), "prod-frasco");

    expect(payload(form).get("displayedSku")).toBe("ORN-111");
    expect(payload(form).get("displayedPresentation")).toBe("frasco");
  });

  // Éste es el corazón. `useActionState` llama a `router.refresh()` ante
  // cualquier respuesta, incluso de acciones ajenas de la misma pantalla: el
  // prop `products` puede llegar con versiones nuevas mientras el formulario
  // está abierto. Adoptarlas en silencio haría que el compare-and-set comparara
  // la versión de hoy contra la de hoy y dejara pasar la entrada que tiene que
  // frenar.
  it("un refresco ajeno NO cambia la versión declarada", async () => {
    const { container, rerender } = render(
      createElement(EntryForm, { products: [FRASCO, SOBRE] }),
    );
    const form = container.querySelector("form") as HTMLFormElement;
    await userEvent.selectOptions(screen.getByLabelText("Producto"), "prod-frasco");

    rerender(
      createElement(EntryForm, {
        products: [{ ...FRASCO, catalogVersion: 99, identityVersion: 88 }, SOBRE],
      }),
    );

    expect(payload(form).get("expectedCatalogVersion")).toBe("7");
    expect(payload(form).get("expectedIdentityVersion")).toBe("3");
  });
});

describe("EntryForm · después de adoptar los datos actualizados", () => {
  const CONFLICTO = {
    name: "Amoxicilina forte",
    sku: "ORN-NUEVO",
    presentation: "caja",
    identityVersion: 9,
    catalogVersion: 12,
  };

  async function conConflictoYAdoptar() {
    mocks.estado = {
      error: "El producto cambió mientras registrabas la entrada.",
      ok: false,
      conflict: CONFLICTO,
    };
    const { container } = render(
      createElement(EntryForm, { products: [FRASCO, SOBRE] }),
    );
    const form = container.querySelector("form") as HTMLFormElement;
    await userEvent.selectOptions(screen.getByLabelText("Producto"), "prod-frasco");
    await userEvent.click(
      screen.getByRole("button", { name: "Usar los datos actualizados" }),
    );
    return form;
  }

  // El defecto: el resumen adoptaba la identidad nueva y la etiqueta del
  // selector seguía diciendo la vieja. La misma fila afirmando dos identidades
  // a la vez, y quien tiene la caja delante sin forma de saber cuál vale.
  it("la etiqueta del selector deja de mostrar la identidad vieja", async () => {
    await conConflictoYAdoptar();

    expect(screen.queryByRole("option", { name: /ORN-111/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /· frasco ·/ })).toBeNull();
  });

  it("la etiqueta del selector y el resumen dicen LO MISMO", async () => {
    await conConflictoYAdoptar();

    expect(
      screen.getByRole("option", {
        name: "Amoxicilina forte — ORN-NUEVO · caja · Genfar",
      }),
    ).toBeTruthy();
    const resumen = screen.getByText(/SKU:/).textContent ?? "";
    expect(resumen).toContain("ORN-NUEVO");
    expect(resumen).toContain("caja");
  });

  it("el producto NO elegido conserva su propia identidad", async () => {
    await conConflictoYAdoptar();

    expect(screen.getByRole("option", { name: /ORN-222 · sobre/ })).toBeTruthy();
  });

  it("recién ahí se declaran las versiones nuevas", async () => {
    const form = await conConflictoYAdoptar();

    expect(payload(form).get("expectedIdentityVersion")).toBe("9");
    expect(payload(form).get("expectedCatalogVersion")).toBe("12");
    expect(payload(form).get("displayedSku")).toBe("ORN-NUEVO");
    expect(payload(form).get("displayedPresentation")).toBe("caja");
  });

  // Adoptar la identidad nueva no es empezar de cero: lo que la persona ya
  // leyó de la caja sigue escrito.
  it("el borrador sobrevive a la adopción", async () => {
    mocks.estado = { error: "El producto cambió.", ok: false, conflict: CONFLICTO };
    const { container } = render(
      createElement(EntryForm, { products: [FRASCO, SOBRE] }),
    );
    const form = container.querySelector("form") as HTMLFormElement;
    await userEvent.selectOptions(screen.getByLabelText("Producto"), "prod-frasco");
    await userEvent.type(screen.getByLabelText("Código de lote"), "LOTE-777");

    await userEvent.click(
      screen.getByRole("button", { name: "Usar los datos actualizados" }),
    );

    expect(payload(form).get("batchCode")).toBe("LOTE-777");
  });

  // Mientras nadie adopte nada, la fotografía manda: un rechazo NO cambia por
  // su cuenta lo que el formulario declara. Adoptarla en silencio dejaría pasar
  // el reintento sin que nadie haya vuelto a mirar la caja.
  it("sin adoptar, sigue declarando la versión que mostró", async () => {
    mocks.estado = { error: "El producto cambió.", ok: false, conflict: CONFLICTO };
    const { container } = render(
      createElement(EntryForm, { products: [FRASCO, SOBRE] }),
    );
    const form = container.querySelector("form") as HTMLFormElement;
    await userEvent.selectOptions(screen.getByLabelText("Producto"), "prod-frasco");

    expect(payload(form).get("expectedCatalogVersion")).toBe("7");
    expect(screen.getByRole("option", { name: /ORN-111 · frasco/ })).toBeTruthy();
  });
});

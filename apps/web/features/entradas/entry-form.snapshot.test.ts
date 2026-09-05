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
    // El conflicto describe UNA fila: sin decir cuál, no se puede adoptar.
    productId: "prod-frasco",
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

// --------------------------------------------------------------------------
// La identidad adoptada pertenece a UN producto, y solo a ese.
//
// El conflicto vuelve del servidor describiendo el producto que cambió. Si esa
// descripción puede caer sobre otro producto, la pantalla afirma una identidad
// que no es la de la fila que se va a escribir — y cuando los dos productos
// están en las mismas versiones (0/0 es lo normal en el catálogo que nadie
// editó), el compare-and-set coincide y la entrada entra igual. Es exactamente
// el error que este slice existe para cerrar, entrando por otra puerta.
// --------------------------------------------------------------------------
describe("EntryForm · el conflicto está atado a su producto", () => {
  const CONFLICTO_DE_FRASCO = {
    productId: "prod-frasco",
    name: "Amoxicilina forte",
    sku: "ORN-NUEVO",
    presentation: "caja",
    identityVersion: 9,
    catalogVersion: 12,
  };

  async function conflictoDeFrascoYElegirSobre() {
    mocks.estado = {
      error: "El producto cambió mientras registrabas la entrada.",
      ok: false,
      conflict: CONFLICTO_DE_FRASCO,
    };
    const { container } = render(
      createElement(EntryForm, { products: [FRASCO, SOBRE] }),
    );
    const form = container.querySelector("form") as HTMLFormElement;
    // El conflicto es del frasco; la persona pasa a otro producto.
    await userEvent.selectOptions(screen.getByLabelText("Producto"), "prod-sobre");
    return form;
  }

  it("no ofrece adoptar la identidad de otro producto", async () => {
    await conflictoDeFrascoYElegirSobre();

    expect(
      screen.queryByRole("button", { name: "Usar los datos actualizados" }),
    ).toBeNull();
  });

  // Esconder el botón no alcanza: la aplicación interna también valida el
  // producto. Si el botón llegara a existir y alguien lo apretara, la identidad
  // del frasco NO puede caer sobre el sobre.
  it("aunque se invoque la adopción, no se aplica al producto equivocado", async () => {
    const form = await conflictoDeFrascoYElegirSobre();

    const boton = screen.queryByRole("button", {
      name: "Usar los datos actualizados",
    });
    if (boton) await userEvent.click(boton);

    expect(screen.getByRole("option", { name: /ORN-222 · sobre/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /ORN-NUEVO/ })).toBeNull();
    const resumen = screen.getByText(/SKU:/).textContent ?? "";
    expect(resumen).toContain("ORN-222");
    expect(resumen).not.toContain("ORN-NUEVO");
    expect(payload(form).get("expectedIdentityVersion")).toBe("1");
    expect(payload(form).get("expectedCatalogVersion")).toBe("2");
  });

  it("el flujo válido sobre el MISMO producto sigue funcionando", async () => {
    mocks.estado = {
      error: "El producto cambió.",
      ok: false,
      conflict: CONFLICTO_DE_FRASCO,
    };
    const { container } = render(
      createElement(EntryForm, { products: [FRASCO, SOBRE] }),
    );
    const form = container.querySelector("form") as HTMLFormElement;
    await userEvent.selectOptions(screen.getByLabelText("Producto"), "prod-frasco");

    await userEvent.click(
      screen.getByRole("button", { name: "Usar los datos actualizados" }),
    );

    expect(
      screen.getByRole("option", {
        name: "Amoxicilina forte — ORN-NUEVO · caja · Genfar",
      }),
    ).toBeTruthy();
    expect(payload(form).get("expectedCatalogVersion")).toBe("12");
  });
});

// --------------------------------------------------------------------------
// UNA sola fotografía manda: etiqueta, resumen, elegido y versiones.
//
// El selector se pintaba del prop VIVO mientras las versiones salían de la
// fotografía congelada. Un refresco ajeno dejaba la etiqueta diciendo lo nuevo
// y el renglón de abajo lo viejo — la misma fila afirmando dos identidades—, y
// un producto recién creado se podía elegir aunque la fotografía no lo tuviera,
// terminando en un error de validación que no explica nada.
// --------------------------------------------------------------------------
describe("EntryForm · el selector sale de la misma fotografía", () => {
  it("un refresco ajeno no cambia la etiqueta del selector", async () => {
    const { container, rerender } = render(
      createElement(EntryForm, { products: [FRASCO, SOBRE] }),
    );
    const form = container.querySelector("form") as HTMLFormElement;
    await userEvent.selectOptions(screen.getByLabelText("Producto"), "prod-frasco");

    rerender(
      createElement(EntryForm, {
        products: [
          {
            ...FRASCO,
            name: "Amoxicilina renombrada",
            orionCode: "ORN-OTRO",
            unit: "ampolla",
            identityVersion: 88,
            catalogVersion: 99,
          },
          SOBRE,
        ],
      }),
    );

    // Etiqueta, resumen y ocultos: los tres siguen ligados a la fotografía.
    expect(
      screen.getByRole("option", { name: "Amoxicilina — ORN-111 · frasco · Genfar" }),
    ).toBeTruthy();
    expect(screen.queryByRole("option", { name: /ORN-OTRO/ })).toBeNull();
    const resumen = screen.getByText(/SKU:/).textContent ?? "";
    expect(resumen).toContain("ORN-111");
    expect(payload(form).get("expectedCatalogVersion")).toBe("7");
  });

  it("un producto que solo existe en las props nuevas no se puede elegir", () => {
    const { rerender } = render(
      createElement(EntryForm, { products: [FRASCO, SOBRE] }),
    );

    rerender(
      createElement(EntryForm, {
        products: [
          FRASCO,
          SOBRE,
          { ...FRASCO, id: "prod-recien-creado", orionCode: "ORN-999" },
        ],
      }),
    );

    expect(screen.queryByRole("option", { name: /ORN-999/ })).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(3); // el vacío + los dos
  });
});

// --------------------------------------------------------------------------
// El vencimiento se captura SIN hora (reunión 2026-10-04).
//
// El campo era `datetime-local`, así que bodega tenía que completar una hora
// que el remito no trae y que después nadie lee: `expiryLevel` compara fechas
// de calendario, nunca horas. Un campo obligatorio que no aporta un dato es un
// campo que se completa con cualquier cosa.
// --------------------------------------------------------------------------
describe("EntryForm · vencimiento sin hora", () => {
  it("captura la fecha de vencimiento con un campo de solo fecha", () => {
    render(createElement(EntryForm, { products: [FRASCO, SOBRE] }));

    const campo = screen.getByLabelText(/Fecha de vencimiento/i) as HTMLInputElement;

    expect(campo.type).toBe("date");
    expect(campo.required).toBe(true);
  });
});

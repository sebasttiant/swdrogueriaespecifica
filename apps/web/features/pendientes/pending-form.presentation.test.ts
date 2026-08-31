import { beforeEach, describe, expect, it, vi } from "vitest";

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

vi.mock("@/server/actions/pending.actions", () => ({
  createPendingAction: vi.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { parseBogotaWallTime } from "@/lib/datetime/bogota";

import { PendingForm, type ProductOption } from "./pending-form";
import { NO_PRESENTATION_LABEL } from "./presentation";

// --------------------------------------------------------------------------
// La PRESENTACIÓN en el formulario de captura.
//
// Dos comportamientos, y la diferencia entre ellos es la regla entera:
//
//   producto del CATÁLOGO  ->  se MUESTRA. No se edita. El catálogo es
//                              información compartida, y un vendedor que la
//                              corrige desde acá se la cambia a todos, en
//                              todos los pedidos, incluidos los ya cargados.
//   producto MANUAL        ->  se ESCRIBE. El producto se está creando en este
//                              mismo gesto; todavía no hay dato compartido que
//                              pisar. Opcional.
//
// Ninguna de las dos formas bloquea la carga: un producto sin presentación se
// puede pedir igual.
// --------------------------------------------------------------------------

const CON_PRESENTACION: ProductOption = {
  id: "p1",
  name: "Lantus Solostar",
  code: "LAN-1",
  orionCode: "7702001234567",
  unit: "Lapicera",
};

const SIN_PRESENTACION: ProductOption = {
  id: "p2",
  name: "Producto legado",
  code: "LEG-1",
  orionCode: null,
  unit: "",
};

function bogotaNow(wall: string): Date {
  const parsed = parseBogotaWallTime(wall);
  if (!parsed) throw new Error(`bad wall time: ${wall}`);
  return parsed;
}

/**
 * Renderiza el formulario con un producto YA ELEGIDO.
 *
 * La selección viaja por el eco de `values`, que es el mismo camino por el que
 * el formulario recupera lo enviado tras un fallo: no hace falta jsdom ni
 * simular el clic para ver qué pinta con un producto seleccionado.
 */
function conProductoElegido(product: ProductOption, products = [product]): string {
  useActionStateMock.mockReturnValue([
    { error: "algo falló", ok: false, values: { productId: product.id } },
    vi.fn(),
    false,
  ]);
  return renderToStaticMarkup(
    createElement(PendingForm, {
      products,
      now: bogotaNow("2026-08-31T10:00"),
      defaultCustom: false,
    }),
  );
}

/** Sin catálogo no hay nada que elegir: el formulario abre en modo manual. */
function enModoManual(): string {
  useActionStateMock.mockReturnValue([{ error: null, ok: false }, vi.fn(), false]);
  return renderToStaticMarkup(
    createElement(PendingForm, {
      products: [],
      now: bogotaNow("2026-08-31T10:00"),
      defaultCustom: false,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useActionStateMock.mockReturnValue([{ error: null, ok: false }, vi.fn(), false]);
});

describe("PendingForm · producto existente CON presentación", () => {
  it("muestra la presentación guardada en el catálogo", () => {
    const html = conProductoElegido(CON_PRESENTACION);

    expect(html).toContain("Presentación:");
    expect(html).toContain("Lapicera");
  });

  // Lo central de todo el cambio: se muestra, no se ofrece editar. Si hubiera
  // un `<input name="manualUnit">` acá, el vendedor estaría escribiendo sobre
  // el catálogo compartido sin saberlo.
  it("NO ofrece ningún campo para editarla", () => {
    const html = conProductoElegido(CON_PRESENTACION);

    expect(html).not.toContain('name="manualUnit"');
    expect(html).not.toContain('id="manualUnit"');
  });

  it("no la llama 'Unidad': el mostrador dice presentación", () => {
    const html = conProductoElegido(CON_PRESENTACION);

    expect(html).not.toContain("Unidad (opcional)");
  });
});

describe("PendingForm · producto existente SIN presentación", () => {
  it("lo dice con palabras en vez de dejar el hueco vacío", () => {
    const html = conProductoElegido(SIN_PRESENTACION);

    expect(html).toContain(NO_PRESENTATION_LABEL);
  });

  // Un producto sin presentación se pide igual: la falta es informativa, no un
  // requisito. Si bloqueara, los ~productos legados quedarían impedidos.
  it("no bloquea la carga: el botón de registrar sigue ahí", () => {
    const html = conProductoElegido(SIN_PRESENTACION);

    expect(html).toContain("<button");
    expect(html).not.toContain("required=\"\" name=\"manualUnit\"");
  });

  it("tampoco ofrece editarla", () => {
    const html = conProductoElegido(SIN_PRESENTACION);

    expect(html).not.toContain('name="manualUnit"');
  });
});

describe("PendingForm · producto manual", () => {
  it("acá SÍ se escribe: el producto se está creando en este gesto", () => {
    const html = enModoManual();

    expect(html).toContain('name="manualUnit"');
  });

  it("se llama Presentación y es opcional", () => {
    const html = enModoManual();

    expect(html).toContain("Presentación (opcional)");
    expect(html).not.toContain("Unidad (opcional)");
  });

  it("da ejemplos de droguería, no una unidad de medida abstracta", () => {
    const html = enModoManual();

    expect(html).toContain("Frasco");
    expect(html).toContain("Sobre");
    expect(html).toContain("Caja");
  });

  it("el campo no es obligatorio", () => {
    const html = enModoManual();

    const campo = html.slice(html.indexOf('id="manualUnit"'));
    const cierre = campo.slice(0, campo.indexOf(">"));
    expect(cierre).not.toContain("required");
  });
});

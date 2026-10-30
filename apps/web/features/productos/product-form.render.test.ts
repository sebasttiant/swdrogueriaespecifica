import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

vi.mock("@/server/actions/product.actions", () => ({
  createProductAction: vi.fn(),
}));

vi.mock("@/server/actions/laboratory.actions", () => ({
  searchLaboratoriesAction: vi.fn(),
  createLaboratoryAction: vi.fn(),
}));

import { ProductForm } from "./product-form";

function render(): string {
  return renderToStaticMarkup(createElement(ProductForm));
}

beforeEach(() => {
  vi.clearAllMocks();
  useActionStateMock.mockReturnValue([{ error: null, ok: false }, vi.fn(), false]);
});

describe("ProductForm", () => {
  it("siempre muestra la búsqueda opcional de laboratorio aunque no haya una lista precargada", () => {
    const html = render();

    expect(html).toContain("Laboratorio (opcional)");
    expect(html).toContain("Buscá uno existente o crealo sin salir del formulario.");
    expect(html).toContain('type="search"');
    expect(html).toContain('name="laboratoryId" value=""');
  });

  it("aclara la presentación con ejemplos farmacéuticos", () => {
    const html = render();

    expect(html).toContain("Presentación / unidad");
    expect(html).toContain("Caja x 20 tabletas");
    expect(html).toContain("Frasco x 120 ml");
    expect(html).toContain("Blíster x 10");
    expect(html).toContain("Unidad");
  });

  it("muestra coincidencias accionables y una confirmación atada al nombre", () => {
    useActionStateMock.mockReturnValue([
      {
        error: "Encontramos productos con el mismo nombre.",
        ok: false,
        submissionId: "duplicate-1",
        values: {
          code: "VAL-2",
          name: "VALCOTE ER 250 MG",
          unit: "Caja",
          minStock: "0",
          reorderQty: "0",
          laboratoryId: "lab-abbott",
          laboratoryName: "Abbott",
          orionCode: "428",
          active: "",
          expectedVersion: "",
          duplicateNameConfirmed: "",
        },
        duplicateCandidates: [
          {
            id: "existing-valcote",
            name: "VALCOTE ER 250 MG",
            code: "PROV-valcote er 250 mg",
            orionCode: null,
            unit: "unidad",
          },
        ],
      },
      vi.fn(),
      false,
    ]);

    const html = render();

    expect(html).toContain("Usar VALCOTE ER 250 MG");
    expect(html).toContain('/productos/existing-valcote');
    expect(html).toContain('name="duplicateNameConfirmed"');
    expect(html).toContain('value="VALCOTE ER 250 MG"');
    expect(html).toContain('value="428"');
    // El laboratorio elegido sobrevive a la alerta: sin el nombre, la
    // confirmación creaba el producto sin laboratorio.
    expect(html).toContain('name="laboratoryId" value="lab-abbott"');
    expect(html).toContain('name="laboratoryName" value="Abbott"');
  });

  it("ubica laboratorio después de presentación y antes de stock mínimo", () => {
    const html = render();

    expect(html.indexOf("Laboratorio (opcional)")).toBeGreaterThan(
      html.indexOf("Presentación / unidad"),
    );
    expect(html.indexOf("Laboratorio (opcional)")).toBeLessThan(
      html.indexOf("Stock mín."),
    );
  });
});

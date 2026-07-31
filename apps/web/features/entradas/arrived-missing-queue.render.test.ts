import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ArrivedMissingItem } from "@/server/repositories/missing-item.repository";

import { ArrivedMissingQueue } from "./arrived-missing-queue";

// --------------------------------------------------------------------------
// La cola de bodega existe para que cargar una caja cueste lo menos posible.
// Estos tests fijan las dos cosas que lo hacen posible —el producto y la
// cantidad viajan hasta el formulario— y la que lo haría inaceptable: que quien
// recibe vea a qué cliente va.
// --------------------------------------------------------------------------

function item(overrides: Partial<ArrivedMissingItem> = {}): ArrivedMissingItem {
  return {
    id: "missing-1",
    productId: "prod-1",
    product: { name: "Gastrofat en sobre", code: "G-001" },
    arrivedAt: new Date("2026-07-30T14:00:00.000Z"),
    requestedByName: "Juan Esteban",
    pendingQuantity: 25,
    ...overrides,
  };
}

function render(items: ArrivedMissingItem[]): string {
  return renderToStaticMarkup(createElement(ArrivedMissingQueue, { items }));
}

describe("ArrivedMissingQueue", () => {
  it("lleva producto y cantidad al formulario, y salta directo a él", () => {
    const html = render([item()]);

    expect(html).toContain("productId=prod-1");
    expect(html).toContain("quantity=25");
    expect(html).toContain("#nueva-entrada");
  });

  it("muestra cuánto hay que cargar sin abrir nada", () => {
    expect(render([item()])).toContain("25 por cargar");
  });

  it("no muestra el nombre del producto sin su cantidad", () => {
    const html = render([item({ pendingQuantity: 3 })]);

    expect(html).toContain("Gastrofat en sobre");
    expect(html).toContain("3 por cargar");
  });

  it("no expone datos del cliente a quien recibe la mercancía", () => {
    const html = render([item()]);

    expect(html).not.toContain("Cliente");
    expect(html).not.toContain("300");
  });

  it("desaparece cuando no hay nada por cargar", () => {
    expect(render([])).toBe("");
  });
});

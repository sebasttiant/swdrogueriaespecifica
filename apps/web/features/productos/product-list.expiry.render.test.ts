// --------------------------------------------------------------------------
// El vencimiento en la lista de Productos: la FECHA, y solo la fecha.
//
// Dos cosas distintas se prueban acá y ninguna cubre a la otra:
//
//   1. Que la fecha concreta se vea. El semáforo dice "Crítico" pero no dice
//      cuándo, y para decidir qué lote se mueve primero hace falta el día.
//   2. Que NO se vea la hora. Un vencimiento es un día; la hora era ruido que
//      además partía la columna en dos líneas en el celular.
// --------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProductList } from "./product-list";
import type { ProductListItem } from "@/server/repositories/product.repository";

function product(overrides: Partial<ProductListItem> = {}): ProductListItem {
  return {
    id: "prod-1",
    code: "P-001",
    name: "Paracetamol",
    unit: "Caja",
    minStock: 5,
    reorderQty: 10,
    active: true,
    createdAt: new Date("2026-01-01T12:00:00.000Z"),
    orionCode: null,
    identityVersion: 1,
    catalogVersion: 1,
    worstExpiresAt: null,
    laboratory: null,
    ...overrides,
  } as ProductListItem;
}

function render(item: ProductListItem): string {
  return renderToStaticMarkup(
    createElement(ProductList, { items: [item], nextCursor: null }),
  );
}

describe("ProductList · vencimiento", () => {
  it("muestra la fecha concreta del peor vencimiento", () => {
    const html = render(
      product({ worstExpiresAt: new Date("2026-12-31T05:00:00.000Z") }),
    );

    expect(html).toContain("31/12/2026");
  });

  // Sin hora, sin minutos, sin zona. El instante guardado tiene hora —la columna
  // es un timestamp— pero la pantalla no la muestra.
  it("no muestra la hora", () => {
    const html = render(
      product({ worstExpiresAt: new Date("2026-12-31T19:30:00.000Z") }),
    );

    expect(html).toContain("31/12/2026");
    expect(html).not.toMatch(/\d{1,2}:\d{2}/);
  });

  // El borde de zona horaria: un instante que en UTC ya es el día siguiente
  // sigue siendo el 31 en Bogotá, y es el 31 lo que hay que mostrar. Con un
  // formateo ingenuo en UTC esta fila diría "1/1/2027".
  it("respeta el día calendario de Bogotá en el borde de la medianoche", () => {
    const html = render(
      // 2027-01-01T02:00Z = 2026-12-31 21:00 en Bogotá.
      product({ worstExpiresAt: new Date("2027-01-01T02:00:00.000Z") }),
    );

    expect(html).toContain("31/12/2026");
    expect(html).not.toContain("1/1/2027");
  });

  it("no muestra nada cuando el producto no tiene lotes con vencimiento", () => {
    const html = render(product({ worstExpiresAt: null }));

    expect(html).not.toContain("Vence");
  });

  // El semáforo NO cambia: sigue apareciendo con su etiqueta y sigue sin
  // aparecer cuando el vencimiento está lejos.
  it("conserva la insignia de severidad junto a la fecha", () => {
    const vencido = render(
      product({ worstExpiresAt: new Date("2020-01-15T05:00:00.000Z") }),
    );

    expect(vencido).toContain("Vencido");
    expect(vencido).toContain("15/1/2020");
  });

  it("no dibuja insignia cuando el vencimiento está lejos, pero sí la fecha", () => {
    const lejano = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
    const html = render(product({ worstExpiresAt: lejano }));

    expect(html).not.toContain("Vencido");
    expect(html).not.toContain("Crítico");
    expect(html).not.toContain("Por vencer");
    expect(html).toContain("Vence");
  });
});

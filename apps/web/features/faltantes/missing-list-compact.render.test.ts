import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MissingItemListEntry } from "@/server/services/missing-item.service";

import { MissingListCompact } from "./missing-list-compact";

function item(overrides: Partial<MissingItemListEntry> = {}): MissingItemListEntry {
  return {
    id: "m-1",
    quantity: 4,
    orderedQuantity: null,
    note: null,
    status: "FALTANTE",
    originId: null,
    confirmedAt: null,
    confirmedById: null,
    confirmationNote: null,
    orderedAt: null,
    orderedById: null,
    supplierId: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    product: {
      id: "p-1",
      name: "Acetaminofén 500mg",
      code: "ACE-500",
      unit: "unidad",
      laboratory: { id: "lab-1", name: "Genfar" },
    },
    origin: null,
    supplier: null,
    confirmedBy: null,
    createdBy: null,
    requestedByName: null,
    ...overrides,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function render(items: MissingItemListEntry[]): string {
  return renderToStaticMarkup(createElement(MissingListCompact, { items }));
}

describe("MissingListCompact", () => {
  it("shows only product name, laboratory and quantity", () => {
    const out = render([item()]);

    expect(out).toContain("Acetaminofén 500mg");
    expect(out).toContain("Genfar");
    expect(out).toContain("4");
  });

  // Lo compacto es justamente NO mostrar el seguimiento ni las acciones.
  it("omits code, status badges and order actions", () => {
    const out = render([item()]);

    expect(out).not.toContain("ACE-500"); // código de producto
    expect(out).not.toContain("Pedir"); // acción de pedido
    expect(out).not.toContain("Estado"); // encabezado de estado
  });

  it("falls back gracefully when the laboratory is missing", () => {
    const out = render([
      item({
        product: { id: "p-2", name: "Sin lab", code: "X-1", unit: "unidad", laboratory: null },
      }),
    ]);

    expect(out).toContain("Sin laboratorio");
  });

  it("renders an empty state when there are no items", () => {
    expect(render([])).toContain("Sin faltantes");
  });
});

describe("MissingListCompact · quién anotó (F1)", () => {
  // El pedido de gerencia: saber qué vendedor registró el faltante. La vista
  // compacta también lo necesita, no solo la completa.
  it("muestra el solicitante en la tarjeta mobile y en la tabla desktop", () => {
    const html = render([item({ requestedByName: "Juan Esteban" })]);

    // Una vez en la tarjeta mobile, otra en la fila desktop.
    expect(countOccurrences(html, "Juan Esteban")).toBe(2);
    expect(html).toMatch(/<th[^>]*>Solicitado por<\/th>/);
  });

  it("marca las filas sin solicitante sin romper la columna", () => {
    const html = render([item({ requestedByName: null })]);

    // La tabla desktop pone un guion; la tarjeta mobile simplemente lo omite.
    expect(html).toContain("—");
  });
});

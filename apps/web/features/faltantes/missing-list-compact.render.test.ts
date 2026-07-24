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

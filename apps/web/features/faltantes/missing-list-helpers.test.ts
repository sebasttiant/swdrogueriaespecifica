import { describe, expect, it } from "vitest";

import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

import { getConfirmationMetadata, getPageOverview } from "./missing-list-helpers";

function item(overrides: Partial<MissingItemListItem>): MissingItemListItem {
  return {
    id: "missing-id",
    quantity: 1,
    status: "FALTANTE",
    originId: null,
    confirmedAt: null,
    confirmedById: null,
    confirmationNote: null,
    orderedAt: null,
    orderedById: null,
    supplierId: null,
    createdAt: new Date("2026-06-01T00:00:00"),
    product: {
      id: "product-id",
      name: "Producto",
      code: "COD-1",
      unit: "unidad",
      laboratory: null,
    },
    origin: null,
    supplier: null,
    ...overrides,
  };
}

describe("getPageOverview", () => {
  it("cuenta totales, abiertos y confirmados para la página visible", () => {
    const confirmedAt = new Date("2026-06-06T12:00:00");
    const items = [
      item({ id: "open-missing", status: "FALTANTE" }),
      item({ id: "open-ordered", status: "PEDIDO" }),
      item({ id: "confirmed", status: "RECIBIDO", confirmedAt }),
      item({ id: "cancelled", status: "CANCELADO" }),
    ];

    expect(getPageOverview(items)).toEqual({ total: 4, open: 2, confirmed: 1 });
  });

  it("no cuenta como abierto un faltante confirmado aunque conserve estado abierto", () => {
    const confirmedAt = new Date("2026-06-06T12:00:00");
    const items = [item({ id: "confirmed-open", status: "FALTANTE", confirmedAt })];

    expect(getPageOverview(items)).toEqual({ total: 1, open: 0, confirmed: 1 });
  });
});

describe("getConfirmationMetadata", () => {
  it("expone metadata pendiente cuando no hay fecha de confirmación", () => {
    expect(getConfirmationMetadata(item({ id: "pending" }))).toEqual({
      label: "Pendiente",
      confirmedAt: null,
    });
  });

  it("expone metadata confirmada cuando hay fecha de confirmación", () => {
    const confirmedAt = new Date("2026-06-06T12:00:00");

    expect(getConfirmationMetadata(item({ id: "confirmed", confirmedAt }))).toEqual({
      label: "Confirmado",
      confirmedAt,
    });
  });
});

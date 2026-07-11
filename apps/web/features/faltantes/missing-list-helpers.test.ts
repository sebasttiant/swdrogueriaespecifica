import { describe, expect, it } from "vitest";

import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

import {
  getConfirmationMetadata,
  getOrderMetadata,
  getPageOverview,
} from "./missing-list-helpers";

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

describe("getOrderMetadata", () => {
  const orderedAt = new Date("2026-06-06T15:30:00");
  const supplier = { id: "supplier-id", name: "Distribuidora Norte" };

  it("expone proveedor y fecha de pedido cuando el faltante está PEDIDO", () => {
    expect(
      getOrderMetadata(item({ status: "PEDIDO", orderedAt, supplier, supplierId: supplier.id })),
    ).toEqual({ supplierName: "Distribuidora Norte", orderedAt });
  });

  it("no expone detalle de pedido para un faltante que todavía no se pidió", () => {
    expect(getOrderMetadata(item({ status: "FALTANTE" }))).toBeNull();
  });

  // Los estados cerrados conservan `supplier`/`orderedAt` en la fila, pero el
  // detalle de pedido describe una orden viva. Mostrarlo sobre RECIBIDO o
  // CANCELADO haría leer como "pedido en curso" algo que ya se cerró.
  it("no expone detalle de pedido sobre estados cerrados aunque conserven los datos", () => {
    expect(
      getOrderMetadata(item({ status: "RECIBIDO", orderedAt, supplier, supplierId: supplier.id })),
    ).toBeNull();
    expect(
      getOrderMetadata(item({ status: "CANCELADO", orderedAt, supplier, supplierId: supplier.id })),
    ).toBeNull();
  });

  // Defensa: el service siempre setea proveedor y fecha al pedir, pero la fila
  // llega del repositorio y no queremos que un dato incompleto rompa el render.
  it("tolera un PEDIDO sin proveedor cargado", () => {
    expect(getOrderMetadata(item({ status: "PEDIDO", orderedAt }))).toEqual({
      supplierName: null,
      orderedAt,
    });
  });

  it("devuelve null cuando un PEDIDO no tiene ni proveedor ni fecha que mostrar", () => {
    expect(getOrderMetadata(item({ status: "PEDIDO" }))).toBeNull();
  });
});

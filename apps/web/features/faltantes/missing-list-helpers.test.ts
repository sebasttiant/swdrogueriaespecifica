import { describe, expect, it } from "vitest";

import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

import { getOrderMetadata } from "./missing-list-helpers";

function item(overrides: Partial<MissingItemListItem>): MissingItemListItem {
  return {
    id: "missing-id",
    quantity: 1,
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
    sellerCode: null,
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
    confirmedBy: null,
    createdBy: null,
    ...overrides,
  };
}

describe("getOrderMetadata", () => {
  const orderedAt = new Date("2026-06-06T15:30:00");
  const supplier = { id: "supplier-id", name: "Distribuidora Norte" };

  it("expone proveedor, fecha y cantidad pedida cuando el faltante está PEDIDO", () => {
    expect(
      getOrderMetadata(
        item({
          status: "PEDIDO",
          orderedAt,
          orderedQuantity: 20,
          supplier,
          supplierId: supplier.id,
        }),
      ),
    ).toEqual({ supplierName: "Distribuidora Norte", orderedAt, orderedQuantity: 20 });
  });

  // Pedido anterior a la columna orderedQuantity: se pidió, pero la cantidad no
  // quedó registrada. No se inventa ni se cae al valor de `quantity`.
  it("expone orderedQuantity null para un PEDIDO legacy sin cantidad registrada", () => {
    const result = getOrderMetadata(
      item({ status: "PEDIDO", orderedAt, supplier, supplierId: supplier.id, orderedQuantity: null }),
    );
    expect(result?.orderedQuantity).toBeNull();
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
      orderedQuantity: null,
    });
  });

  it("devuelve null cuando un PEDIDO no tiene ni proveedor ni fecha que mostrar", () => {
    expect(getOrderMetadata(item({ status: "PEDIDO" }))).toBeNull();
  });
});

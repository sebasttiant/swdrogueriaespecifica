import { describe, expect, it } from "vitest";

import {
  canShowNewSupplierOrderForm,
  canTransitionToOrdered,
} from "./order-rules";

describe("missing item order rules", () => {
  it("permite ordenar solo faltantes todavía no pedidos ni recibidos", () => {
    expect(canTransitionToOrdered("FALTANTE")).toBe(true);
    expect(canTransitionToOrdered("PEDIDO")).toBe(false);
    expect(canTransitionToOrdered("RECIBIDO")).toBe(false);
    expect(canTransitionToOrdered("CANCELADO")).toBe(false);
  });

  it("muestra el formulario con proveedor nuevo solo con ambas capacidades", () => {
    expect(
      canShowNewSupplierOrderForm({
        canOrderMissingItems: true,
        canManageSuppliers: true,
      }),
    ).toBe(true);
    expect(
      canShowNewSupplierOrderForm({
        canOrderMissingItems: true,
        canManageSuppliers: false,
      }),
    ).toBe(false);
    expect(
      canShowNewSupplierOrderForm({
        canOrderMissingItems: false,
        canManageSuppliers: true,
      }),
    ).toBe(false);
  });
});

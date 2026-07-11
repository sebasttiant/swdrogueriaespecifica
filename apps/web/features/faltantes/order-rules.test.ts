import { describe, expect, it } from "vitest";

import {
  canShowNewSupplierOrderForm,
  canShowOrderForm,
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

// Pedir a un proveedor EXISTENTE solo exige `canOrderMissingItems`: el backend
// nunca pide `canManageSuppliers` en esa rama. Antes el formulario exigía ambas
// siempre, así que quien podía pedir pero no crear proveedores no veía ninguna
// forma de pedir, pese a que el servidor se lo permitía.
describe("canShowOrderForm", () => {
  it("ofrece el formulario a quien puede pedir cuando ya hay proveedores, aunque no pueda crearlos", () => {
    expect(
      canShowOrderForm({
        canOrderMissingItems: true,
        canManageSuppliers: false,
        hasSuppliers: true,
      }),
    ).toBe(true);
  });

  it("ofrece el formulario a quien puede crear proveedores aunque todavía no exista ninguno", () => {
    expect(
      canShowOrderForm({
        canOrderMissingItems: true,
        canManageSuppliers: true,
        hasSuppliers: false,
      }),
    ).toBe(true);
  });

  // Sin proveedores que elegir y sin permiso para crearlos, no hay pedido posible:
  // ofrecer el formulario sería prometer una acción que el servidor va a rechazar.
  it("oculta el formulario cuando no hay proveedores y no puede crearlos", () => {
    expect(
      canShowOrderForm({
        canOrderMissingItems: true,
        canManageSuppliers: false,
        hasSuppliers: false,
      }),
    ).toBe(false);
  });

  it("oculta el formulario a quien no puede pedir, sin importar el resto", () => {
    expect(
      canShowOrderForm({
        canOrderMissingItems: false,
        canManageSuppliers: true,
        hasSuppliers: true,
      }),
    ).toBe(false);
  });
});

/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReceiverQueue } from "./receiver-queue";
import type { ReceiverItem } from "@/server/services/missing-receiver.service";

// --------------------------------------------------------------------------
// Un producto sin SKU no se puede recibir, y decirlo no alcanza.
//
// Bodega veía "Falta el SKU" y el rechazo de la entrada decía "completalo en
// Productos". Ninguno de los dos decía CUÁL producto. Con tres artículos
// llamados "Gel Caliente Muscular", "Gel Muscular Caliente" y "Gel Caliente
// Muscular", buscarlo a mano reabre exactamente el error que este flujo viene
// a cerrar: elegir el equivocado.
//
// El id ya está decidido por el faltante. Que la persona lo vuelva a buscar es
// pedirle que resuelva otra vez algo que el sistema ya sabe.
// --------------------------------------------------------------------------

function faltante(overrides: Partial<ReceiverItem> = {}): ReceiverItem {
  return {
    id: "mi-1",
    originId: null,
    productId: "prod-gel-1",
    productName: "Gel Caliente Muscular",
    orionCode: null,
    unit: "unidad",
    laboratoryName: null,
    requestedLaboratoryName: null,
    orderedQuantity: 10,
    receivedQuantity: 0,
    outstandingQuantity: 10,
    status: "PEDIDO",
    orderedAt: new Date("2026-08-28T10:00:00Z"),
    ...overrides,
  };
}

const montar = (items: ReceiverItem[]) =>
  render(createElement(ReceiverQueue, { items, scope: "PEDIDO" as const }));

const enlacesSinSku = () => screen.queryAllByRole("link", { name: /falta el sku/i });

afterEach(cleanup);

describe("cola de bodega · producto sin SKU", () => {
  it("enlaza al producto EXACTO, no a la lista", () => {
    montar([faltante()]);

    expect(enlacesSinSku()[0]?.getAttribute("href")).toBe("/productos/prod-gel-1");
  });

  it("dice que hay algo que hacer, no solo que falta", () => {
    montar([faltante()]);

    expect(screen.getByRole("link", { name: /completalo/i })).toBeDefined();
  });

  // Cada fila apunta a SU producto. Un href compartido mandaría a bodega al
  // producto equivocado, que es el defecto original con otra forma.
  it("cada fila apunta a su propio producto", () => {
    montar([
      faltante({ id: "mi-1", productId: "prod-a" }),
      faltante({ id: "mi-2", productId: "prod-b", productName: "Gel Muscular Caliente" }),
    ]);

    expect(enlacesSinSku().map((e) => e.getAttribute("href"))).toEqual([
      "/productos/prod-a",
      "/productos/prod-b",
    ]);
  });

  it("con SKU cargado muestra el código y NO ofrece completarlo", () => {
    montar([faltante({ orionCode: "ORN-4412" })]);

    expect(screen.getByText("ORN-4412")).toBeDefined();
    expect(enlacesSinSku()).toHaveLength(0);
  });
});

/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/actions/missing-receiver.actions", () => ({
  markMissingItemArrivedAction: vi.fn(),
}));

import { ReceiverQueue } from "./receiver-queue";
import type {
  ReceiverItem,
  ReceiverScope,
} from "@/server/services/missing-receiver.service";

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

const montar = (items: ReceiverItem[], scope: ReceiverScope = "PEDIDO") =>
  render(createElement(ReceiverQueue, { items, scope }));

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

// --------------------------------------------------------------------------
// Cada pestaña ofrece UN gesto, el suyo.
//
// La cadena se cortaba acá: "Ya pedidos" solo mostraba el texto "Esperando que
// llegue". Nada movía un faltante a EN_BODEGA, así que "En bodega" quedaba
// siempre vacía y "Registrar entrada" —que solo existe en esa pestaña— no se
// alcanzaba nunca. Bodega recibía la caja y no tenía dónde decirlo.
// --------------------------------------------------------------------------
describe("cola de bodega · el gesto de cada pestaña", () => {
  it("en 'Ya pedidos' ofrece marcar la llegada", () => {
    montar([faltante({ productName: "Vitamina D" })], "PEDIDO");

    expect(
      screen.getByRole("button", { name: /llegó vitamina d/i }),
    ).toBeDefined();
  });

  // Marcar la llegada NO es registrar la entrada: la caja está acá, pero hasta
  // que no se cargan lote, vencimiento y cantidad real no hay stock.
  it("en 'Ya pedidos' todavía NO ofrece registrar la entrada", () => {
    montar([faltante()], "PEDIDO");

    expect(screen.queryByRole("link", { name: /registrar entrada/i })).toBeNull();
  });

  it("en 'En bodega' ofrece registrar la entrada", () => {
    montar([faltante({ status: "EN_BODEGA" })], "EN_BODEGA");

    expect(
      screen.getByRole("link", { name: /registrar entrada/i }).getAttribute("href"),
    ).toContain("missingItemId=mi-1");
  });

  // Volver a marcar la llegada de algo que ya está en bodega no significa nada.
  it("en 'En bodega' ya no ofrece marcar la llegada", () => {
    montar([faltante({ status: "EN_BODEGA" })], "EN_BODEGA");

    expect(screen.queryByRole("button", { name: /llegó/i })).toBeNull();
  });

  it("cada fila marca SU propio faltante", () => {
    montar(
      [
        faltante({ id: "mi-1", productName: "Vitamina D" }),
        faltante({ id: "mi-2", productName: "Crema Ponds" }),
      ],
      "PEDIDO",
    );

    expect(screen.getByRole("button", { name: /llegó vitamina d/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /llegó crema ponds/i })).toBeDefined();
  });
});

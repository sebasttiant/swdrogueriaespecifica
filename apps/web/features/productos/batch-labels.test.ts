import { describe, expect, it } from "vitest";

import {
  batchCodeLabel,
  batchCodeTitle,
  batchExpiryLabel,
  batchExpiryTitle,
} from "./batch-labels";

// --------------------------------------------------------------------------
// El código reservado NO se le muestra a nadie.
//
// "SIN LOTE 2027-01-15" es la representación interna de una caja que llegó sin
// número de lote. En pantalla se lee "Sin lote": la fecha ya se muestra en su
// propia columna, y "Lote SIN LOTE 2027-01-15" invita a buscar en el estante un
// lote que no existe.
// --------------------------------------------------------------------------

describe("batchCodeLabel", () => {
  it("un lote real se muestra tal cual", () => {
    expect(batchCodeLabel("L-2027-001")).toBe("L-2027-001");
  });

  it("el código reservado se lee 'Sin lote'", () => {
    expect(batchCodeLabel("SIN LOTE")).toBe("Sin lote");
    expect(batchCodeLabel("SIN LOTE 2027-01-15")).toBe("Sin lote");
  });

  it("un código que solo empieza parecido se muestra tal cual", () => {
    expect(batchCodeLabel("SIN LOTES DEL PROVEEDOR")).toBe(
      "SIN LOTES DEL PROVEEDOR",
    );
  });
});

describe("batchCodeTitle", () => {
  it("un lote real lleva la palabra 'Lote' adelante", () => {
    expect(batchCodeTitle("L-2027-001")).toBe("Lote L-2027-001");
  });

  // "Lote Sin lote" no se le dice a nadie.
  it("el código reservado NO lleva el prefijo", () => {
    expect(batchCodeTitle("SIN LOTE 2027-01-15")).toBe("Sin lote");
  });
});

describe("batchExpiryLabel", () => {
  it("una fecha conocida se muestra como fecha de Bogotá", () => {
    expect(batchExpiryLabel(new Date("2027-01-15T05:00:00.000Z"))).toBe(
      "15/1/2027",
    );
  });

  it("sin fecha se lee 'Sin vencimiento'", () => {
    expect(batchExpiryLabel(null)).toBe("Sin vencimiento");
  });
});

describe("batchExpiryTitle", () => {
  it("una fecha conocida se anuncia con 'Vence'", () => {
    expect(batchExpiryTitle(new Date("2027-01-15T05:00:00.000Z"))).toBe(
      "Vence: 15/1/2027",
    );
  });

  // "Vence: Sin vencimiento" se contradice solo.
  it("sin fecha se lee 'Sin vencimiento', sin el 'Vence'", () => {
    expect(batchExpiryTitle(null)).toBe("Sin vencimiento");
  });
});

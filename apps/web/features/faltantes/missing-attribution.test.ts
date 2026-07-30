import { describe, expect, it } from "vitest";

import { missingAttribution, UNKNOWN_ACTOR } from "./missing-attribution";

const ORDERED_AT = new Date("2026-07-30T14:00:00.000Z");
const DISCARDED_AT = new Date("2026-07-30T15:00:00.000Z");
const CONFIRMED_AT = new Date("2026-07-01T10:00:00.000Z");

function item(overrides: Partial<Parameters<typeof missingAttribution>[0]> = {}) {
  return {
    status: "FALTANTE" as const,
    orderedAt: null,
    orderedBy: null,
    discardedAt: null,
    discardedBy: null,
    confirmedAt: null,
    confirmedBy: null,
    ...overrides,
  };
}

describe("missingAttribution", () => {
  // Un faltante que nadie tocó no tiene nada que atribuir: sigue esperando.
  it("no atribuye nada a un faltante todavía en la cola", () => {
    expect(missingAttribution(item())).toBeNull();
  });

  it("muestra quién lo pidió y cuándo", () => {
    const result = missingAttribution(
      item({
        status: "PEDIDO",
        orderedAt: ORDERED_AT,
        orderedBy: { id: "u-1", name: "Guillermo Bonilla" },
      }),
    );

    expect(result).toEqual({
      label: "Pedido por",
      name: "Guillermo Bonilla",
      at: ORDERED_AT,
    });
  });

  it("muestra quién lo descartó y cuándo", () => {
    const result = missingAttribution(
      item({
        status: "CANCELADO",
        discardedAt: DISCARDED_AT,
        discardedBy: { id: "u-2", name: "Andrés Bonilla" },
      }),
    );

    expect(result).toEqual({
      label: "Descartado por",
      name: "Andrés Bonilla",
      at: DISCARDED_AT,
    });
  });

  // Distinguir a Guillermo de Andrés es el punto entero de esta función: son
  // los dos que trabajan la misma cola.
  it("distingue pedido de descarte, que son hechos opuestos", () => {
    const ordered = missingAttribution(
      item({ status: "PEDIDO", orderedAt: ORDERED_AT }),
    );
    const discarded = missingAttribution(
      item({ status: "CANCELADO", discardedAt: DISCARDED_AT }),
    );

    expect(ordered?.label).not.toBe(discarded?.label);
  });

  // Registros del flujo viejo "OK gerencia": quedaron en FALTANTE con
  // `confirmedAt`. Fueron compras reales, así que se leen como pedidos.
  it("lee un pedido histórico confirmado como pedido", () => {
    const result = missingAttribution(
      item({
        confirmedAt: CONFIRMED_AT,
        confirmedBy: { id: "u-3", name: "Gerencia" },
      }),
    );

    expect(result).toEqual({
      label: "Pedido por",
      name: "Gerencia",
      at: CONFIRMED_AT,
    });
  });

  // Nunca inventar un nombre ni caer al usuario que está mirando la pantalla:
  // eso convertiría un dato faltante en una atribución falsa.
  it("dice 'Sin registrar' cuando el responsable no se puede resolver", () => {
    const result = missingAttribution(
      item({ status: "PEDIDO", orderedAt: ORDERED_AT, orderedBy: null }),
    );

    expect(result?.name).toBe(UNKNOWN_ACTOR);
  });

  it("no rompe con una fila heredada sin fecha ni responsable", () => {
    const result = missingAttribution(item({ status: "PEDIDO" }));

    expect(result).toEqual({
      label: "Pedido por",
      name: UNKNOWN_ACTOR,
      at: null,
    });
  });
});

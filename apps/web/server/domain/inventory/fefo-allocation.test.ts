import { describe, expect, it } from "vitest";

import { planFefoAllocation, type AllocatableLot } from "./fefo-allocation";

// El planificador es puro: decide CÓMO repartir una cantidad entre los lotes
// que le dan, sin tocar la base. Por eso se prueba entero acá, y lo que queda
// para PostgreSQL es solo lo que solo ahí se puede probar: la atomicidad.

function lot(id: string, available: number): AllocatableLot {
  return { id, available };
}

describe("planFefoAllocation", () => {
  it("toma todo de un solo lote cuando alcanza", () => {
    const plan = planFefoAllocation([lot("A", 50)], 30);

    expect(plan.lines).toEqual([{ lotId: "A", quantity: 30 }]);
    expect(plan.allocated).toBe(30);
    expect(plan.shortfall).toBe(0);
  });

  // El orden en que llegan los lotes ES el orden FEFO: lo fija
  // `listEligibleLots` (T1.2) con su desempate reproducible. El planificador lo
  // respeta y no reordena, para que no existan dos definiciones de FEFO.
  it("agota el primero antes de tocar el siguiente", () => {
    const plan = planFefoAllocation([lot("vence-antes", 10), lot("vence-despues", 40)], 25);

    expect(plan.lines).toEqual([
      { lotId: "vence-antes", quantity: 10 },
      { lotId: "vence-despues", quantity: 15 },
    ]);
    expect(plan.allocated).toBe(25);
  });

  it("cruza tantos lotes como haga falta", () => {
    const plan = planFefoAllocation([lot("A", 5), lot("B", 5), lot("C", 5)], 13);

    expect(plan.lines).toEqual([
      { lotId: "A", quantity: 5 },
      { lotId: "B", quantity: 5 },
      { lotId: "C", quantity: 3 },
    ]);
    expect(plan.shortfall).toBe(0);
  });

  // El déficit se INFORMA, no se lanza: quien pide decide si una entrega
  // parcial sirve. En una droguería muchas veces sirve.
  it("informa el déficit en vez de fallar cuando no alcanza", () => {
    const plan = planFefoAllocation([lot("A", 4), lot("B", 3)], 20);

    expect(plan.allocated).toBe(7);
    expect(plan.shortfall).toBe(13);
    expect(plan.lines).toHaveLength(2);
  });

  it("no deja líneas en cero: un lote sin disponible no entra al plan", () => {
    const plan = planFefoAllocation([lot("vacio", 0), lot("con-stock", 10)], 6);

    expect(plan.lines).toEqual([{ lotId: "con-stock", quantity: 6 }]);
  });

  // Un disponible negativo es un lote sobre-comprometido: ya se prometió más de
  // lo que hay. Sacarle unidades empeoraría el agujero.
  it("ignora un lote con disponible negativo", () => {
    const plan = planFefoAllocation([lot("roto", -5), lot("sano", 10)], 4);

    expect(plan.lines).toEqual([{ lotId: "sano", quantity: 4 }]);
  });

  it("sin lotes, todo es déficit", () => {
    const plan = planFefoAllocation([], 9);

    expect(plan.lines).toEqual([]);
    expect(plan.allocated).toBe(0);
    expect(plan.shortfall).toBe(9);
  });

  it("deja de repartir apenas cubre la cantidad", () => {
    const plan = planFefoAllocation([lot("A", 100), lot("B", 100)], 10);

    expect(plan.lines).toHaveLength(1);
  });

  // Pedir cero o una fracción no es un plan vacío: es un error del llamador, y
  // callarlo dejaría pasar una reserva que nadie asentaría.
  it("rechaza una cantidad que no sea un entero positivo", () => {
    expect(() => planFefoAllocation([lot("A", 10)], 0)).toThrow(RangeError);
    expect(() => planFefoAllocation([lot("A", 10)], -3)).toThrow(RangeError);
    expect(() => planFefoAllocation([lot("A", 10)], 2.5)).toThrow(RangeError);
  });

  // El mismo plan tiene que dar las mismas líneas en el mismo orden: de eso
  // depende que las claves de idempotencia por línea sirvan en un reintento.
  it("es reproducible: mismas entradas, mismo plan", () => {
    const lots = [lot("A", 7), lot("B", 9)];

    expect(planFefoAllocation(lots, 12)).toEqual(planFefoAllocation(lots, 12));
  });
});

import { describe, expect, it } from "vitest";

import { derivePaymentState, remainingAmount } from "./payment-state";

describe("derivePaymentState", () => {
  it("sin abono cuando el cliente no entregó plata", () => {
    expect(derivePaymentState({ totalAmount: 50_000, paidAmount: 0 })).toBe("SIN_ABONO");
  });

  it("abonado cuando el abono no cubre el total", () => {
    expect(derivePaymentState({ totalAmount: 50_000, paidAmount: 20_000 })).toBe("ABONADO");
  });

  it("pagado cuando el abono cubre exactamente el total", () => {
    expect(derivePaymentState({ totalAmount: 50_000, paidAmount: 50_000 })).toBe("PAGADO");
  });

  it("pagado cuando el abono supera el total (vuelto a favor, no deuda)", () => {
    expect(derivePaymentState({ totalAmount: 50_000, paidAmount: 60_000 })).toBe("PAGADO");
  });

  // Caso real: producto manual que todavía hay que cotizar, pero el cliente ya
  // dejó plata. Afirmar "pagado" sin saber contra qué total sería inventar.
  it("nunca dice pagado si no hay total acordado, por alto que sea el abono", () => {
    expect(derivePaymentState({ totalAmount: null, paidAmount: 999_000 })).toBe("ABONADO");
  });

  it("sin abono manda aunque no haya total acordado", () => {
    expect(derivePaymentState({ totalAmount: null, paidAmount: 0 })).toBe("SIN_ABONO");
  });
});

describe("remainingAmount", () => {
  it("es la diferencia entre el total y lo abonado", () => {
    expect(remainingAmount({ totalAmount: 50_000, paidAmount: 20_000 })).toBe(30_000);
  });

  it("es cero cuando ya está pagado", () => {
    expect(remainingAmount({ totalAmount: 50_000, paidAmount: 50_000 })).toBe(0);
  });

  // Un abono mayor al total es plata a favor del cliente, no una deuda negativa.
  it("nunca es negativo si el abono superó el total", () => {
    expect(remainingAmount({ totalAmount: 50_000, paidAmount: 60_000 })).toBe(0);
  });

  it("es null sin total acordado: no hay contra qué restar", () => {
    expect(remainingAmount({ totalAmount: null, paidAmount: 20_000 })).toBeNull();
  });
});

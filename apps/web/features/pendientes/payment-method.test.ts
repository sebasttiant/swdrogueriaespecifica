import { describe, expect, it } from "vitest";

import {
  PAYMENT_METHODS,
  isPaymentMethod,
  paymentMethodLabel,
} from "./payment-method";

describe("PAYMENT_METHODS", () => {
  it("son los cuatro medios del mostrador, sin bancos ni billeteras", () => {
    expect(PAYMENT_METHODS).toEqual([
      "EFECTIVO",
      "TRANSFERENCIA",
      "TARJETA_DEBITO",
      "TARJETA_CREDITO",
    ]);
  });

  it("no repite ningún medio", () => {
    expect(new Set(PAYMENT_METHODS).size).toBe(PAYMENT_METHODS.length);
  });
});

describe("paymentMethodLabel", () => {
  it("traduce cada medio a lo que se lee en pantalla", () => {
    expect(paymentMethodLabel("EFECTIVO")).toBe("Efectivo");
    expect(paymentMethodLabel("TRANSFERENCIA")).toBe("Transferencia");
    expect(paymentMethodLabel("TARJETA_DEBITO")).toBe("Tarjeta débito");
    expect(paymentMethodLabel("TARJETA_CREDITO")).toBe("Tarjeta crédito");
  });

  // Sin esto, agregar un medio al enum y olvidar su etiqueta pasa el
  // typecheck si alguien afloja el Record y llega a producción mostrando
  // "TARJETA_CREDITO" en crudo al cliente.
  it("no deja ningún medio sin etiqueta", () => {
    for (const method of PAYMENT_METHODS) {
      expect(paymentMethodLabel(method)).toBeTruthy();
      expect(paymentMethodLabel(method)).not.toBe(method);
    }
  });

  it("dos medios distintos no comparten etiqueta", () => {
    const labels = PAYMENT_METHODS.map(paymentMethodLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("isPaymentMethod", () => {
  it("acepta los medios del vocabulario", () => {
    for (const method of PAYMENT_METHODS) {
      expect(isPaymentMethod(method)).toBe(true);
    }
  });

  // El valor llega de un <select> por FormData: es texto de la red, no un
  // tipo. Cualquiera puede mandar otra cosa.
  it("rechaza lo que no es un medio, incluida la etiqueta que se ve en pantalla", () => {
    expect(isPaymentMethod("NEQUI")).toBe(false);
    expect(isPaymentMethod("Efectivo")).toBe(false);
    expect(isPaymentMethod("")).toBe(false);
    expect(isPaymentMethod(null)).toBe(false);
    expect(isPaymentMethod(undefined)).toBe(false);
    expect(isPaymentMethod(3)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  EXPIRY_WARNING_DAYS,
  expiryLevel,
  isAgotado,
  isSellable,
} from "./batch-status";

const NOW = new Date("2026-06-05T00:00:00.000Z");
const daysFromNow = (n: number) =>
  new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

describe("expiryLevel", () => {
  it("marca vencido cuando la fecha ya pasó o es ahora", () => {
    expect(expiryLevel(daysFromNow(-1), NOW)).toBe("expired");
    expect(expiryLevel(NOW, NOW)).toBe("expired");
  });

  it("marca por-vencer dentro de la ventana (1..90 días)", () => {
    expect(expiryLevel(daysFromNow(1), NOW)).toBe("warning");
    expect(expiryLevel(daysFromNow(30), NOW)).toBe("warning");
    expect(expiryLevel(daysFromNow(EXPIRY_WARNING_DAYS), NOW)).toBe("warning");
  });

  it("marca ok cuando vence más allá de la ventana", () => {
    expect(expiryLevel(daysFromNow(EXPIRY_WARNING_DAYS + 1), NOW)).toBe("ok");
    expect(expiryLevel(daysFromNow(365), NOW)).toBe("ok");
  });
});

describe("isAgotado", () => {
  it("es agotado cuando la cantidad es 0 o menos", () => {
    expect(isAgotado(0)).toBe(true);
    expect(isAgotado(-3)).toBe(true);
  });

  it("no es agotado con cantidad positiva", () => {
    expect(isAgotado(5)).toBe(false);
  });
});

describe("isSellable", () => {
  const base = { status: "DISPONIBLE" as const, quantity: 10 };

  it("es vendible: disponible, con stock y no vencido", () => {
    expect(isSellable({ ...base, expiresAt: daysFromNow(120) }, NOW)).toBe(true);
  });

  it("no es vendible si está vencido", () => {
    expect(isSellable({ ...base, expiresAt: daysFromNow(-1) }, NOW)).toBe(false);
  });

  it("no es vendible si está agotado", () => {
    expect(
      isSellable({ ...base, quantity: 0, expiresAt: daysFromNow(120) }, NOW),
    ).toBe(false);
  });

  it("no es vendible si está en cuarentena o retenido", () => {
    expect(
      isSellable(
        { status: "CUARENTENA", quantity: 10, expiresAt: daysFromNow(120) },
        NOW,
      ),
    ).toBe(false);
    expect(
      isSellable(
        { status: "RETENIDO", quantity: 10, expiresAt: daysFromNow(120) },
        NOW,
      ),
    ).toBe(false);
  });
});

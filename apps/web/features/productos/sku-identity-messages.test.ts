import { describe, expect, it } from "vitest";

import type { SkuIdentityCode } from "@/server/domain/catalog/sku-identity";

import {
  SKU_IDENTITY_CONCURRENCY_MESSAGE,
  SKU_IDENTITY_MESSAGES,
  messageForIdentityError,
} from "./sku-identity-messages";

// Los códigos son del dominio; los mensajes son del operador. Este test fija
// que ninguno de los dos se filtre al otro lado: el operador nunca ve
// "ORION_CONFLICT", y agregar un código nuevo al dominio rompe el typecheck
// antes que la pantalla.

const ALL_CODES: SkuIdentityCode[] = [
  "AMBIGUOUS_MODE",
  "FORBIDDEN_ACTOR",
  "MISSING_EXACT_IDENTITY",
  "UNKNOWN_SKU",
  "ID_SKU_MISMATCH",
  "ORION_CONFLICT",
  "GENERATION_EXHAUSTED",
];

describe("SKU identity messages", () => {
  it("covers every typed code", () => {
    for (const code of ALL_CODES) {
      expect(SKU_IDENTITY_MESSAGES[code]).toBeTruthy();
    }
    expect(Object.keys(SKU_IDENTITY_MESSAGES).sort()).toEqual([...ALL_CODES].sort());
  });

  it("never leaks the raw code to the operator", () => {
    for (const code of ALL_CODES) {
      expect(SKU_IDENTITY_MESSAGES[code]).not.toContain(code);
      expect(SKU_IDENTITY_MESSAGES[code]).not.toMatch(/[A-Z]{4,}_[A-Z]/);
    }
  });

  it("gives each failure its own message, so two causes never read the same", () => {
    const messages = ALL_CODES.map((code) => SKU_IDENTITY_MESSAGES[code]);

    expect(new Set(messages).size).toBe(ALL_CODES.length);
  });

  it("tells apart a taken code from an already-linked product", () => {
    expect(SKU_IDENTITY_MESSAGES.ORION_CONFLICT).not.toBe(
      SKU_IDENTITY_MESSAGES.UNKNOWN_SKU,
    );
  });

  it("resolves a known error to its message", () => {
    expect(messageForIdentityError("ORION_CONFLICT")).toBe(
      SKU_IDENTITY_MESSAGES.ORION_CONFLICT,
    );
  });

  it("falls back without exposing anything when the cause is unknown", () => {
    const fallback = messageForIdentityError(undefined);

    expect(fallback).toBeTruthy();
    expect(Object.values(SKU_IDENTITY_MESSAGES)).not.toContain(fallback);
  });

  // Perder el compare-and-set NO es un `SkuIdentityError`: viene de otra clase
  // (`SkuConcurrencyError`) y significa algo distinto de todo lo demás. Nada
  // de lo que escribió el operador está mal; simplemente otro llegó antes.
  // Meterlo en el mensaje genérico lo mandaría a corregir un dato que está
  // bien.
  it("says losing the race is its own thing, not a data error", () => {
    expect(SKU_IDENTITY_CONCURRENCY_MESSAGE).toBeTruthy();
    expect(Object.values(SKU_IDENTITY_MESSAGES)).not.toContain(
      SKU_IDENTITY_CONCURRENCY_MESSAGE,
    );
    expect(SKU_IDENTITY_CONCURRENCY_MESSAGE).not.toBe(messageForIdentityError(undefined));
  });
});

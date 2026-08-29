import { describe, expect, it } from "vitest";

import { isStale } from "./app-version";

// --------------------------------------------------------------------------
// Qué cuenta como desfase, y sobre todo qué NO.
//
// Un falso positivo acá no es cosmético: bloquea Facturar, Entregar y Cancelar
// en todo el mostrador. Por eso la duda siempre se resuelve a favor de dejar
// operar.
// --------------------------------------------------------------------------
describe("isStale", () => {
  it("marca desfase cuando los builds difieren", () => {
    expect(isStale("abc1234", "def5678")).toBe(true);
  });

  it("no marca desfase con el mismo build", () => {
    expect(isStale("abc1234", "abc1234")).toBe(false);
  });

  // `unknown` es "no sé", no "cambió". En desarrollo no hay despliegue del que
  // desfasarse; y si la variable no llegara al build por un error de
  // configuración, callarse es infinitamente mejor que bloquear la operación
  // entera por un dato que falta.
  it("un 'unknown' del cliente NUNCA marca desfase", () => {
    expect(isStale("unknown", "def5678")).toBe(false);
  });

  it("un 'unknown' del servidor NUNCA marca desfase", () => {
    expect(isStale("abc1234", "unknown")).toBe(false);
  });

  it("dos 'unknown' —desarrollo— no molestan", () => {
    expect(isStale("unknown", "unknown")).toBe(false);
  });
});

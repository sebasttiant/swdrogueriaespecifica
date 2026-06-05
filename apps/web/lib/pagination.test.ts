import { describe, expect, it } from "vitest";

import {
  clampTake,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
  MAX_PAGE_SIZE,
} from "./pagination";

describe("cursor", () => {
  it("hace round-trip de un id", () => {
    const cursor = encodeCursor("abc123");
    expect(cursor).not.toBe("abc123"); // opaco
    expect(decodeCursor(cursor)).toBe("abc123");
  });

  it("devuelve null al decodificar un cursor inválido", () => {
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("###no-base64###")).toBeNull();
  });
});

describe("clampTake", () => {
  it("usa el default cuando no se pasa nada", () => {
    expect(clampTake(undefined)).toBe(DEFAULT_PAGE_SIZE);
  });

  it("acota al mínimo de 1", () => {
    expect(clampTake(0)).toBe(1);
    expect(clampTake(-5)).toBe(1);
  });

  it("acota al máximo", () => {
    expect(clampTake(9999)).toBe(MAX_PAGE_SIZE);
  });

  it("respeta un valor válido", () => {
    expect(clampTake(15)).toBe(15);
  });
});

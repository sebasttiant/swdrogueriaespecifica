import { describe, expect, it } from "vitest";

import { parseBogotaWallTime } from "./bogota";

describe("parseBogotaWallTime", () => {
  it("interpreta la hora como Colombia (UTC-5) y devuelve el UTC correcto", () => {
    const result = parseBogotaWallTime("2026-06-09T14:30");
    expect(result?.toISOString()).toBe("2026-06-09T19:30:00.000Z");
  });

  it("no depende del timezone del runtime (resultado absoluto en UTC)", () => {
    // Medianoche Colombia → 05:00Z del mismo día.
    expect(parseBogotaWallTime("2026-01-01T00:00")?.toISOString()).toBe(
      "2026-01-01T05:00:00.000Z",
    );
  });

  it("acepta segundos opcionales", () => {
    expect(parseBogotaWallTime("2026-06-09T14:30:45")?.toISOString()).toBe(
      "2026-06-09T19:30:45.000Z",
    );
  });

  it("rechaza string vacío", () => {
    expect(parseBogotaWallTime("")).toBeNull();
  });

  it("rechaza formato no datetime-local", () => {
    expect(parseBogotaWallTime("09/06/2026 14:30")).toBeNull();
    expect(parseBogotaWallTime("not-a-date")).toBeNull();
  });

  it("rechaza fechas/horas fuera de rango", () => {
    expect(parseBogotaWallTime("2026-13-01T10:00")).toBeNull(); // mes 13
    expect(parseBogotaWallTime("2026-02-30T10:00")).toBeNull(); // 30 de febrero
    expect(parseBogotaWallTime("2026-06-09T25:00")).toBeNull(); // hora 25
  });
});

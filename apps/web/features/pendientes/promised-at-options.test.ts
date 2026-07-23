import { describe, expect, it } from "vitest";

import { parseBogotaWallTime } from "@/lib/datetime/bogota";

import {
  buildPromisedAtOptions,
  defaultPromisedAtValue,
} from "./promised-at-options";

// `now` construido como hora de pared de Bogotá, para que el test no dependa de
// la zona de la máquina que lo corre.
function bogotaNow(wall: string): Date {
  const parsed = parseBogotaWallTime(wall);
  if (!parsed) throw new Error(`bad wall time: ${wall}`);
  return parsed;
}

describe("buildPromisedAtOptions", () => {
  it("offers the three quick options with Bogota wall-time values", () => {
    const options = buildPromisedAtOptions(bogotaNow("2026-07-24T10:00"));

    expect(options.map((o) => o.value)).toEqual([
      "2026-07-24T18:00",
      "2026-07-25T12:00",
      "2026-07-25T18:00",
    ]);
    expect(options.map((o) => o.label)).toEqual([
      "Hoy antes de las 18:00",
      "Mañana antes de las 12:00",
      "Mañana antes de las 18:00",
    ]);
  });

  it("keeps 'hoy 18:00' available when the Bogota time is still before it", () => {
    const options = buildPromisedAtOptions(bogotaNow("2026-07-24T10:00"));
    const today = options.find((o) => o.key === "today-18");

    expect(today?.disabled).toBe(false);
  });

  // Ofrecer "hoy antes de las 18:00" a las 19:00 sería una fecha vencida de
  // entrada: se deshabilita.
  it("disables 'hoy 18:00' once the Bogota time is past it", () => {
    const options = buildPromisedAtOptions(bogotaNow("2026-07-24T19:00"));
    const today = options.find((o) => o.key === "today-18");

    expect(today?.disabled).toBe(true);
  });

  it("disables 'hoy 18:00' exactly at 18:00 (not strictly future)", () => {
    const options = buildPromisedAtOptions(bogotaNow("2026-07-24T18:00"));
    const today = options.find((o) => o.key === "today-18");

    expect(today?.disabled).toBe(true);
  });

  it("never disables the tomorrow options, even late at night", () => {
    const options = buildPromisedAtOptions(bogotaNow("2026-07-24T23:59"));
    const tomorrow = options.filter((o) => o.key.startsWith("tomorrow"));

    expect(tomorrow.every((o) => !o.disabled)).toBe(true);
  });

  it("crosses the month boundary correctly for 'mañana'", () => {
    const options = buildPromisedAtOptions(bogotaNow("2026-07-31T10:00"));

    expect(options.find((o) => o.key === "tomorrow-12")?.value).toBe(
      "2026-08-01T12:00",
    );
  });

  it("produces values that round-trip through parseBogotaWallTime", () => {
    for (const option of buildPromisedAtOptions(bogotaNow("2026-07-24T10:00"))) {
      expect(parseBogotaWallTime(option.value)).not.toBeNull();
    }
  });
});

describe("defaultPromisedAtValue", () => {
  it("defaults to today 18:00 when it is still available", () => {
    expect(defaultPromisedAtValue(bogotaNow("2026-07-24T10:00"))).toBe(
      "2026-07-24T18:00",
    );
  });

  // Si "hoy 18:00" ya pasó, el default cae a la primera opción disponible.
  it("falls back to tomorrow 12:00 when today 18:00 is past", () => {
    expect(defaultPromisedAtValue(bogotaNow("2026-07-24T19:00"))).toBe(
      "2026-07-25T12:00",
    );
  });
});

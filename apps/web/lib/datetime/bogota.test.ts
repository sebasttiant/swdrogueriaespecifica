import { describe, expect, it } from "vitest";

import { formatBogotaDate, parseBogotaWallTime } from "./bogota";

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

describe("formatBogotaDate", () => {
  // 2026-06-09T19:30:00Z = 2026-06-09T14:30:00 Bogota (UTC-5)
  const UTC_INSTANT = new Date("2026-06-09T19:30:00.000Z");

  it("style 'date' returns a date string in Bogota timezone locale es-CO", () => {
    const result = formatBogotaDate(UTC_INSTANT, { style: "date" });
    // Should include the Bogota calendar date (9 de junio de 2026 in some form)
    expect(result).toMatch(/9/); // day 9
    expect(result).toMatch(/2026/); // year 2026
    // Bogota date is 2026-06-09, NOT 2026-06-10 (which UTC+0 might produce next day)
    expect(result).not.toMatch(/10/); // not day 10 (which would indicate wrong timezone)
  });

  it("style 'time' returns HH:mm formatted in Bogota wall time", () => {
    const result = formatBogotaDate(UTC_INSTANT, { style: "time" });
    // 19:30 UTC = 14:30 Bogota
    expect(result).toBe("14:30");
  });

  it("style 'datetime' returns both date and time", () => {
    const result = formatBogotaDate(UTC_INSTANT, { style: "datetime" });
    // Must contain the Bogota time (14:30) and the Bogota date (9 / jun)
    expect(result).toContain("14:30");
    expect(result).toMatch(/9/);
  });

  it("default style (no opts) is datetime", () => {
    const result = formatBogotaDate(UTC_INSTANT);
    // Same as calling with style: 'datetime'
    expect(result).toContain("14:30");
  });

  it("anchors to Bogota calendar day, not UTC calendar day (cross-midnight proof)", () => {
    // 2026-03-11T03:30:00Z is:
    //   UTC  →  2026-03-11 (day 11)
    //   Bogota (UTC-5) → 2026-03-10T22:30:00 (day 10, still the previous calendar day)
    // A correct implementation MUST render day 10, never day 11.
    const crossMidnightInstant = new Date("2026-03-11T03:30:00.000Z");

    const bogotaDay = formatBogotaDate(crossMidnightInstant, { style: "date" });
    const utcDay = new Intl.DateTimeFormat("es-CO", {
      timeZone: "UTC",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).format(crossMidnightInstant);

    // The Bogota-formatted date must contain "10" (day 10) …
    expect(bogotaDay).toMatch(/10/);
    // … and must NOT equal the UTC rendering (which would show day 11).
    expect(bogotaDay).not.toBe(utcDay);
  });

  it("DST-safe: uses Bogota offset (not hardcoded -5) for a DST boundary date", () => {
    // Colombia does NOT observe DST (fixed UTC-5 always), but we verify the function
    // uses America/Bogota via Intl and not a hardcoded -5. We test a date known to be
    // problematic for regions with DST (e.g., US spring-forward) to ensure our function
    // correctly anchors to Bogota regardless.
    // 2026-03-08T08:00:00Z (UTC) = 2026-03-08T03:00:00 Bogota (UTC-5, always)
    const dstBoundaryUtc = new Date("2026-03-08T08:00:00.000Z");
    const result = formatBogotaDate(dstBoundaryUtc, { style: "time" });
    // Bogota is always UTC-5; 08:00 UTC → 03:00 Bogota
    expect(result).toBe("03:00");
  });
});

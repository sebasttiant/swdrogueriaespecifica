import { describe, expect, it } from "vitest";

import { bogotaCalendarDaysUntil, expiryLevel } from "./batch-status";

// 2026-06-09 17:00 UTC = 2026-06-09 12:00 Bogotá (mediodía).
const NOON = new Date("2026-06-09T17:00:00.000Z");
// Mismo día de calendario Bogotá, casi medianoche: 2026-06-09 23:30 Bogotá.
const LATE_NIGHT = new Date("2026-06-10T04:30:00.000Z");

const bogotaMidday = (ymd: string) => new Date(`${ymd}T17:00:00.000Z`);

describe("bogotaCalendarDaysUntil", () => {
  it("is 0 the day the batch expires", () => {
    expect(bogotaCalendarDaysUntil(bogotaMidday("2026-06-09"), NOON)).toBe(0);
  });

  it("counts the days still left", () => {
    expect(bogotaCalendarDaysUntil(bogotaMidday("2026-06-10"), NOON)).toBe(1);
    expect(bogotaCalendarDaysUntil(bogotaMidday("2026-07-09"), NOON)).toBe(30);
    expect(bogotaCalendarDaysUntil(bogotaMidday("2026-09-07"), NOON)).toBe(90);
  });

  it("goes negative once the date has passed", () => {
    expect(bogotaCalendarDaysUntil(bogotaMidday("2026-06-08"), NOON)).toBe(-1);
    expect(bogotaCalendarDaysUntil(bogotaMidday("2026-05-30"), NOON)).toBe(-10);
  });

  // La razón de contar por calendario y no por milisegundos: a las 23:30 de
  // Bogotá "mañana" sigue siendo 1 día, no 0.
  it("does not shrink to zero late in the Bogota evening", () => {
    expect(bogotaCalendarDaysUntil(bogotaMidday("2026-06-10"), LATE_NIGHT)).toBe(1);
  });

  // El número y el semáforo tienen que contar la misma historia. Si divergen,
  // la fila dice "faltan 25 días" con la insignia en "Por vencer".
  it.each([
    ["2026-06-08", "expired"],
    ["2026-06-09", "expired"],
    ["2026-06-10", "critical"],
    ["2026-07-09", "critical"],
    ["2026-07-10", "warning"],
    ["2026-09-07", "warning"],
    ["2026-09-08", "ok"],
  ] as const)("agrees with expiryLevel at %s (%s)", (ymd, level) => {
    const at = bogotaMidday(ymd);
    const days = bogotaCalendarDaysUntil(at, NOON);

    expect(expiryLevel(at, NOON)).toBe(level);
    if (level === "expired") expect(days).toBeLessThanOrEqual(0);
    if (level === "critical") expect(days).toBeGreaterThan(0);
    if (level === "critical") expect(days).toBeLessThanOrEqual(30);
    if (level === "warning") expect(days).toBeGreaterThan(30);
    if (level === "warning") expect(days).toBeLessThanOrEqual(90);
    if (level === "ok") expect(days).toBeGreaterThan(90);
  });
});

import { describe, expect, it } from "vitest";

import {
  EXPIRY_CRITICAL_DAYS,
  EXPIRY_WARNING_DAYS,
  expiryLevel,
  isAgotado,
  isSellable,
} from "./batch-status";

// ---------------------------------------------------------------------------
// Calendar-day helpers for test construction.
//
// We derive "today in Bogota" using Intl (same approach as the implementation)
// so the test inputs are calendar-day-anchored, not timestamp-anchored.
// ---------------------------------------------------------------------------
const BOGOTA_TZ = "America/Bogota";

/** Returns the {year, month (1-based), day} triple for `date` in Bogota. */
function bogotaCalendarDate(date: Date): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BOGOTA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * Constructs a Date whose Bogota calendar date equals (todayBogota + offsetDays).
 * Returns UTC noon (12:00Z) on that Bogota calendar day, which corresponds to
 * 07:00 Bogota — safely inside that calendar day.
 *
 * Colombia is UTC-5 with no DST. Key invariant: Date.UTC(y, m-1, d, 12) for the
 * Bogota calendar date (y,m,d) maps to Bogota 07:00 — always within that day.
 */
function bogotaDatePlusDays(referenceNow: Date, offsetDays: number): Date {
  const base = bogotaCalendarDate(referenceNow);
  // Start from UTC noon of the base Bogota calendar date (safely within that day
  // in Bogota). Add offsetDays as milliseconds.
  const utcNoonBase = Date.UTC(base.year, base.month - 1, base.day, 12, 0, 0);
  const utcNoonTarget = utcNoonBase + offsetDays * 24 * 60 * 60 * 1000;
  // Re-derive Bogota calendar date from the shifted UTC instant and return
  // UTC noon of that target calendar day.
  const { year, month, day } = bogotaCalendarDate(new Date(utcNoonTarget));
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

// Use a fixed reference "now" so tests are deterministic.
// This represents a real moment in time; Bogota calendar date is derived from it.
const REF_NOW = new Date("2026-06-09T17:00:00.000Z"); // Bogota: 2026-06-09 12:00

describe("EXPIRY_CRITICAL_DAYS constant", () => {
  it("has value 30", () => {
    expect(EXPIRY_CRITICAL_DAYS).toBe(30);
  });
});

describe("EXPIRY_WARNING_DAYS constant", () => {
  it("retains value 90", () => {
    expect(EXPIRY_WARNING_DAYS).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// Core boundary tests (spec R4) — TDD RED first
// ---------------------------------------------------------------------------
describe("expiryLevel — calendar-day Bogota boundaries", () => {
  it("exactly today (Bogota calendar date) → expired", () => {
    const today = bogotaDatePlusDays(REF_NOW, 0);
    expect(expiryLevel(today, REF_NOW)).toBe("expired");
  });

  it("exactly today + 30 calendar days (Bogota) → critical", () => {
    const plus30 = bogotaDatePlusDays(REF_NOW, 30);
    expect(expiryLevel(plus30, REF_NOW)).toBe("critical");
  });

  it("exactly today + 31 calendar days (Bogota) → warning (just beyond critical boundary)", () => {
    const plus31 = bogotaDatePlusDays(REF_NOW, 31);
    expect(expiryLevel(plus31, REF_NOW)).toBe("warning");
  });

  it("exactly today + 90 calendar days (Bogota) → warning", () => {
    const plus90 = bogotaDatePlusDays(REF_NOW, 90);
    expect(expiryLevel(plus90, REF_NOW)).toBe("warning");
  });

  it("exactly today + 91 calendar days (Bogota) → ok", () => {
    const plus91 = bogotaDatePlusDays(REF_NOW, 91);
    expect(expiryLevel(plus91, REF_NOW)).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Additional tier coverage
// ---------------------------------------------------------------------------
describe("expiryLevel — tier coverage", () => {
  it("batch in the past → expired", () => {
    const past = bogotaDatePlusDays(REF_NOW, -1);
    expect(expiryLevel(past, REF_NOW)).toBe("expired");
  });

  it("batch at today − 30 days (well in past) → expired", () => {
    const old = bogotaDatePlusDays(REF_NOW, -30);
    expect(expiryLevel(old, REF_NOW)).toBe("expired");
  });

  it("batch at today + 1 → critical", () => {
    const plus1 = bogotaDatePlusDays(REF_NOW, 1);
    expect(expiryLevel(plus1, REF_NOW)).toBe("critical");
  });

  it("batch at today + 15 → critical", () => {
    const plus15 = bogotaDatePlusDays(REF_NOW, 15);
    expect(expiryLevel(plus15, REF_NOW)).toBe("critical");
  });

  it("batch at today + 60 → warning", () => {
    const plus60 = bogotaDatePlusDays(REF_NOW, 60);
    expect(expiryLevel(plus60, REF_NOW)).toBe("warning");
  });

  it("batch at today + 365 → ok", () => {
    const plus365 = bogotaDatePlusDays(REF_NOW, 365);
    expect(expiryLevel(plus365, REF_NOW)).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// isSellable — MUST NOT be changed. Tests preserved verbatim.
// ---------------------------------------------------------------------------
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
  // isSellable uses timestamp comparison (expiresAt > now), NOT calendar-day.
  // This is the separate transactional sell gate — intentionally unchanged.
  const base = { status: "DISPONIBLE" as const, quantity: 10 };

  it("es vendible: disponible, con stock y no vencido", () => {
    // Use a date clearly in the future at timestamp level
    const future = new Date(REF_NOW.getTime() + 120 * 24 * 60 * 60 * 1000);
    expect(isSellable({ ...base, expiresAt: future }, REF_NOW)).toBe(true);
  });

  it("no es vendible si está vencido (expiresAt <= now timestamp)", () => {
    const past = new Date(REF_NOW.getTime() - 1000);
    expect(isSellable({ ...base, expiresAt: past }, REF_NOW)).toBe(false);
  });

  it("no es vendible si está agotado", () => {
    const future = new Date(REF_NOW.getTime() + 120 * 24 * 60 * 60 * 1000);
    expect(
      isSellable({ ...base, quantity: 0, expiresAt: future }, REF_NOW),
    ).toBe(false);
  });

  it("no es vendible si está en cuarentena o retenido", () => {
    const future = new Date(REF_NOW.getTime() + 120 * 24 * 60 * 60 * 1000);
    expect(
      isSellable(
        { status: "CUARENTENA", quantity: 10, expiresAt: future },
        REF_NOW,
      ),
    ).toBe(false);
    expect(
      isSellable(
        { status: "RETENIDO", quantity: 10, expiresAt: future },
        REF_NOW,
      ),
    ).toBe(false);
  });

  it("critical batch IS sellable (critical is a display tier, not a sell gate)", () => {
    // A batch expiring in 15 days is CRITICAL tier, but still sellable if DISPONIBLE
    const critical = bogotaDatePlusDays(REF_NOW, 15);
    expect(isSellable({ ...base, expiresAt: critical }, REF_NOW)).toBe(true);
  });
});

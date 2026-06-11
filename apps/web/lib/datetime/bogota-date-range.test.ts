import { describe, expect, it } from "vitest";

import { bogotaDayToUtcRange } from "./bogota-date-range";

// Colombia is UTC-5 (no DST). These tests verify the helper correctly converts
// YYYY-MM-DD date strings (as received from input[type=date]) to UTC boundaries.
//
// Boundary convention: EXCLUSIVE next-day (start-of-next-day UTC).
//   from "2026-06-10" → gte: 2026-06-10T05:00:00.000Z (midnight Bogota = 05:00 UTC)
//   to   "2026-06-10" → lt:  2026-06-11T05:00:00.000Z (midnight next day Bogota)

describe("bogotaDayToUtcRange", () => {
  // ---------------------------------------------------------------------------
  // from boundary — start-of-day Bogota as UTC
  // ---------------------------------------------------------------------------

  it("converts 'from' date to start-of-day Bogota (00:00:00 COT = 05:00:00 UTC)", () => {
    const { from } = bogotaDayToUtcRange({ from: "2026-06-10" });
    // 2026-06-10 00:00:00 COT = 2026-06-10T05:00:00.000Z
    expect(from).toEqual(new Date("2026-06-10T05:00:00.000Z"));
  });

  it("converts 'from' date at January boundary (no DST risk)", () => {
    const { from } = bogotaDayToUtcRange({ from: "2026-01-01" });
    // 2026-01-01 00:00:00 COT = 2026-01-01T05:00:00.000Z
    expect(from).toEqual(new Date("2026-01-01T05:00:00.000Z"));
  });

  it("converts 'from' date at December boundary", () => {
    const { from } = bogotaDayToUtcRange({ from: "2025-12-31" });
    // 2025-12-31 00:00:00 COT = 2025-12-31T05:00:00.000Z
    expect(from).toEqual(new Date("2025-12-31T05:00:00.000Z"));
  });

  // ---------------------------------------------------------------------------
  // to boundary — exclusive start-of-NEXT-day Bogota as UTC
  // ---------------------------------------------------------------------------

  it("converts 'to' date to start-of-NEXT-day Bogota (exclusive upper bound)", () => {
    const { to } = bogotaDayToUtcRange({ to: "2026-06-10" });
    // 2026-06-11 00:00:00 COT = 2026-06-11T05:00:00.000Z
    expect(to).toEqual(new Date("2026-06-11T05:00:00.000Z"));
  });

  it("converts 'to' date at month end correctly (month rollover)", () => {
    const { to } = bogotaDayToUtcRange({ to: "2026-06-30" });
    // 2026-07-01 00:00:00 COT = 2026-07-01T05:00:00.000Z
    expect(to).toEqual(new Date("2026-07-01T05:00:00.000Z"));
  });

  it("converts 'to' date at year end correctly (year rollover)", () => {
    const { to } = bogotaDayToUtcRange({ to: "2025-12-31" });
    // 2026-01-01 00:00:00 COT = 2026-01-01T05:00:00.000Z
    expect(to).toEqual(new Date("2026-01-01T05:00:00.000Z"));
  });

  // ---------------------------------------------------------------------------
  // undefined inputs — omit the boundary
  // ---------------------------------------------------------------------------

  it("returns undefined 'from' when from param is undefined", () => {
    const { from } = bogotaDayToUtcRange({ to: "2026-06-10" });
    expect(from).toBeUndefined();
  });

  it("returns undefined 'to' when to param is undefined", () => {
    const { to } = bogotaDayToUtcRange({ from: "2026-06-10" });
    expect(to).toBeUndefined();
  });

  it("returns both undefined when called with empty object", () => {
    const result = bogotaDayToUtcRange({});
    expect(result.from).toBeUndefined();
    expect(result.to).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // same-day range — from and to on the same date
  // ---------------------------------------------------------------------------

  it("returns correct UTC range for same-day from+to (full day in Bogota)", () => {
    const { from, to } = bogotaDayToUtcRange({
      from: "2026-06-10",
      to: "2026-06-10",
    });
    expect(from).toEqual(new Date("2026-06-10T05:00:00.000Z"));
    expect(to).toEqual(new Date("2026-06-11T05:00:00.000Z"));
  });

  // ---------------------------------------------------------------------------
  // invalid / empty strings — treat as undefined
  // ---------------------------------------------------------------------------

  it("returns undefined 'from' when from is empty string", () => {
    const { from } = bogotaDayToUtcRange({ from: "" });
    expect(from).toBeUndefined();
  });

  it("returns undefined 'to' when to is empty string", () => {
    const { to } = bogotaDayToUtcRange({ to: "" });
    expect(to).toBeUndefined();
  });
});

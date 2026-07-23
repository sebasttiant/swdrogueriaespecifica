import { describe, expect, it } from "vitest";

import { normalizeMissingReportName } from "./missing-report-name";

const E_ACUTE_COMPOSED = "\u00e9";
const E_ACUTE_DECOMPOSED = "e\u0301";

describe("normalizeMissingReportName", () => {
  it("trims outer whitespace", () => {
    expect(normalizeMissingReportName("  acetaminofen  ")).toBe("acetaminofen");
  });

  it("collapses repeated inner whitespace to a single space", () => {
    expect(normalizeMissingReportName("acetaminofen   500   mg")).toBe(
      "acetaminofen 500 mg",
    );
  });

  it("handles control whitespace without joining words", () => {
    expect(normalizeMissingReportName("acetaminofen\t500\nmg")).toBe(
      "acetaminofen 500 mg",
    );
  });

  it("lowercases for comparison", () => {
    expect(normalizeMissingReportName("ACETAMINOFEN ACME")).toBe(
      "acetaminofen acme",
    );
  });

  it("keeps accents so distinct names stay distinct", () => {
    const withAccent = `acetaminof${E_ACUTE_COMPOSED}n`;
    expect(normalizeMissingReportName(withAccent)).toBe(withAccent);
    expect(normalizeMissingReportName("acetaminofen")).not.toBe(
      normalizeMissingReportName(withAccent),
    );
  });

  it("normalizes Unicode to NFC so equal names compare equal", () => {
    const composed = `acetaminof${E_ACUTE_COMPOSED}n`;
    const decomposed = `acetaminof${E_ACUTE_DECOMPOSED}n`;
    expect(composed).not.toBe(decomposed);
    expect(normalizeMissingReportName(composed)).toBe(
      normalizeMissingReportName(decomposed),
    );
  });

  it("preserves an accented character as a single NFC code point", () => {
    const decomposed = `acetaminof${E_ACUTE_DECOMPOSED}n`;
    expect(normalizeMissingReportName(decomposed)).toBe(
      `acetaminof${E_ACUTE_COMPOSED}n`,
    );
  });

  it("replaces C0, C1, and DEL control characters safely", () => {
    const withControls = "acetaminofen\u0000\u0009\u007f\u0085\u009f500 mg";
    expect(normalizeMissingReportName(withControls)).toBe("acetaminofen 500 mg");
  });

  it("returns an empty string for an empty input", () => {
    expect(normalizeMissingReportName("")).toBe("");
  });

  it("returns an empty string for a whitespace-only input", () => {
    expect(normalizeMissingReportName("   \t\n  ")).toBe("");
  });

  it("is idempotent", () => {
    const once = normalizeMissingReportName(
      `  ACETAMINOF${E_ACUTE_DECOMPOSED}N   500\tMG  `,
    );
    expect(normalizeMissingReportName(once)).toBe(once);
  });
});

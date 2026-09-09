import { describe, expect, it } from "vitest";

import {
  hasUnreadManagementObservation,
  isManagementObservationChanged,
  isManagementObservationTooLong,
  managementObservationSummary,
  MANAGEMENT_OBSERVATION_MAX_LENGTH,
  normalizeManagementObservation,
} from "./management-observation";

describe("normalizeManagementObservation", () => {
  it("treats blank input as no observation", () => {
    expect(normalizeManagementObservation("")).toBeNull();
    expect(normalizeManagementObservation("   ")).toBeNull();
    expect(normalizeManagementObservation("\n\n  \t ")).toBeNull();
    expect(normalizeManagementObservation(null)).toBeNull();
    expect(normalizeManagementObservation(undefined)).toBeNull();
  });

  it("collapses spaces without destroying the line breaks of a list", () => {
    expect(normalizeManagementObservation("  Llega   el lunes  ")).toBe("Llega el lunes");
    expect(normalizeManagementObservation("Uno\nDos")).toBe("Uno\nDos");
    expect(normalizeManagementObservation("Uno\r\nDos")).toBe("Uno\nDos");
    expect(normalizeManagementObservation("Uno\n\n\n\nDos")).toBe("Uno\n\nDos");
  });
});

describe("isManagementObservationChanged", () => {
  it("does not consider whitespace-only edits a change", () => {
    expect(isManagementObservationChanged("Llega el lunes", "  Llega el lunes  ")).toBe(false);
    expect(isManagementObservationChanged("Llega el lunes", "Llega   el lunes")).toBe(false);
  });

  it("sees a real edit and a clear", () => {
    expect(isManagementObservationChanged("Llega el lunes", "Llega el martes")).toBe(true);
    expect(isManagementObservationChanged("Llega el lunes", "   ")).toBe(true);
    expect(isManagementObservationChanged(null, "Llega el lunes")).toBe(true);
  });

  it("clearing an already empty observation is not a change", () => {
    expect(isManagementObservationChanged(null, "")).toBe(false);
  });
});

describe("isManagementObservationTooLong", () => {
  it("measures the normalised text, not the raw input", () => {
    const atLimit = "a".repeat(MANAGEMENT_OBSERVATION_MAX_LENGTH);
    expect(isManagementObservationTooLong(atLimit)).toBe(false);
    expect(isManagementObservationTooLong(`${atLimit}a`)).toBe(true);
    expect(isManagementObservationTooLong(null)).toBe(false);
  });
});

describe("managementObservationSummary", () => {
  it("returns the text untouched when it already fits", () => {
    expect(managementObservationSummary("Llega el lunes")).toBe("Llega el lunes");
  });

  it("flattens line breaks so the list keeps one line", () => {
    expect(managementObservationSummary("Uno\nDos")).toBe("Uno · Dos");
  });

  it("clips long text on a word boundary and marks the cut", () => {
    const summary = managementObservationSummary(
      "El proveedor confirmo que el pedido llega el lunes por la tarde y que la factura viaja aparte con el remito del deposito central",
      40,
    );
    expect(summary).not.toBeNull();
    expect(summary!.length).toBeLessThanOrEqual(41);
    expect(summary!.endsWith("…")).toBe(true);
    expect(summary!).not.toContain("  ");
  });

  it("has nothing to summarise when there is no observation", () => {
    expect(managementObservationSummary(null)).toBeNull();
    expect(managementObservationSummary("   ")).toBeNull();
  });
});

describe("hasUnreadManagementObservation", () => {
  it("is unread while the seller has not caught up with the version", () => {
    expect(
      hasUnreadManagementObservation({
        observation: "Llega el lunes",
        version: 1,
        readVersion: 0,
      }),
    ).toBe(true);
  });

  it("a seller that never read anything still gets the notice", () => {
    expect(
      hasUnreadManagementObservation({
        observation: "Llega el lunes",
        version: 1,
        readVersion: null,
      }),
    ).toBe(true);
  });

  it("goes quiet once the read version matches", () => {
    expect(
      hasUnreadManagementObservation({
        observation: "Llega el lunes",
        version: 1,
        readVersion: 1,
      }),
    ).toBe(false);
  });

  it("a later edit wakes it again", () => {
    expect(
      hasUnreadManagementObservation({
        observation: "Llega el martes",
        version: 2,
        readVersion: 1,
      }),
    ).toBe(true);
  });

  it("a cleared observation leaves no orphan notice, whatever the version says", () => {
    expect(
      hasUnreadManagementObservation({
        observation: null,
        version: 7,
        readVersion: 1,
      }),
    ).toBe(false);
  });
});

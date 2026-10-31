import { describe, expect, it } from "vitest";

import { pickOrionConflictSurvivor } from "./orion-conflict-survivor";

const day = (n: number) => new Date(`2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`);

describe("pickOrionConflictSurvivor", () => {
  it("elige la única copia con stock", () => {
    const decision = pickOrionConflictSurvivor("A31972", [
      { id: "old", orionCode: "31972", stock: 5, createdAt: day(1) },
      { id: "new", orionCode: "a-31972", stock: 0, createdAt: day(2) },
    ]);
    expect(decision).toEqual({ status: "pick", survivorId: "old" });
  });

  it("bloquea cuando dos copias tienen stock", () => {
    const decision = pickOrionConflictSurvivor("A1", [
      { id: "a", orionCode: "1", stock: 2, createdAt: day(1) },
      { id: "b", orionCode: "A-1", stock: 1, createdAt: day(2) },
    ]);
    expect(decision.status).toBe("blocked");
  });

  it("sin stock prefiere la forma canónica", () => {
    const decision = pickOrionConflictSurvivor("A20956", [
      { id: "raw", orionCode: "20956", stock: 0, createdAt: day(1) },
      { id: "can", orionCode: "A20956", stock: 0, createdAt: day(3) },
    ]);
    expect(decision).toEqual({ status: "pick", survivorId: "can" });
  });

  it("sin stock ni canónico elige la más vieja", () => {
    const decision = pickOrionConflictSurvivor("A50", [
      { id: "newer", orionCode: "a-50", stock: 0, createdAt: day(5) },
      { id: "older", orionCode: "50", stock: 0, createdAt: day(2) },
    ]);
    expect(decision).toEqual({ status: "pick", survivorId: "older" });
  });
});

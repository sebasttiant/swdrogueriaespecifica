import { describe, expect, it } from "vitest";

import { resolveMissingView } from "./missing-view";

describe("resolveMissingView", () => {
  it("returns 'compact' only for exactly 'compact'", () => {
    expect(resolveMissingView("compact")).toBe("compact");
  });

  // COMPLETA es el default: gerencia necesita ver el detalle apenas entra.
  // La compacta queda a un toque para quien la pida explícitamente.
  it("falls back to 'full' for anything else", () => {
    expect(resolveMissingView("Compact")).toBe("full");
    expect(resolveMissingView("compacta")).toBe("full");
    expect(resolveMissingView("")).toBe("full");
    expect(resolveMissingView(undefined)).toBe("full");
    expect(resolveMissingView(null)).toBe("full");
  });
});

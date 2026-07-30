import { describe, expect, it } from "vitest";

import { resolveMissingView } from "./missing-view";

describe("resolveMissingView", () => {
  it("returns 'full' only for exactly 'full'", () => {
    expect(resolveMissingView("full")).toBe("full");
  });

  // COMPACTA es el default: es la vista que se puede escanear con cientos de
  // filas. La completa queda para quien pida el detalle explícitamente.
  it("falls back to 'compact' for anything else", () => {
    expect(resolveMissingView("Full")).toBe("compact");
    expect(resolveMissingView("completa")).toBe("compact");
    expect(resolveMissingView("")).toBe("compact");
    expect(resolveMissingView(undefined)).toBe("compact");
    expect(resolveMissingView(null)).toBe("compact");
  });
});

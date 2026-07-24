import { describe, expect, it } from "vitest";

import { resolveMissingView } from "./missing-view";

describe("resolveMissingView", () => {
  it("returns 'compact' only for exactly 'compact'", () => {
    expect(resolveMissingView("compact")).toBe("compact");
  });

  it("falls back to 'full' for anything else", () => {
    expect(resolveMissingView("full")).toBe("full");
    expect(resolveMissingView("Compact")).toBe("full");
    expect(resolveMissingView("compacta")).toBe("full");
    expect(resolveMissingView("")).toBe("full");
    expect(resolveMissingView(undefined)).toBe("full");
    expect(resolveMissingView(null)).toBe("full");
  });
});

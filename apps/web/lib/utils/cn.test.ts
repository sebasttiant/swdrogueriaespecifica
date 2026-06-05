import { describe, expect, it } from "vitest";

import { cn } from "./cn";

describe("cn", () => {
  it("resuelve conflictos de Tailwind (último gana)", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("ignora valores falsy", () => {
    expect(cn("text-sm", false, undefined, "font-bold")).toBe("text-sm font-bold");
  });
});

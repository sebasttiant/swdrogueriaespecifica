import { describe, expect, it } from "vitest";

import { hasRole } from "./require-role";

describe("hasRole", () => {
  it("permite cuando el rol está en la lista", () => {
    expect(hasRole("ADMIN", ["ADMIN"])).toBe(true);
    expect(hasRole("LIDER", ["ADMIN", "LIDER"])).toBe(true);
  });

  it("niega cuando el rol no está en la lista", () => {
    expect(hasRole("OPERADOR", ["ADMIN", "LIDER"])).toBe(false);
  });

  it("niega con lista vacía de roles permitidos", () => {
    expect(hasRole("ADMIN", [])).toBe(false);
  });
});

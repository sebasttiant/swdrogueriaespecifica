import { describe, expect, it } from "vitest";

import { isPublicRoute } from "./config.edge";

describe("isPublicRoute", () => {
  it("reconoce /login como pública", () => {
    expect(isPublicRoute("/login")).toBe(true);
    expect(isPublicRoute("/login/recuperar")).toBe(true);
  });

  it("trata rutas internas como privadas", () => {
    expect(isPublicRoute("/dashboard")).toBe(false);
    expect(isPublicRoute("/productos")).toBe(false);
  });
});

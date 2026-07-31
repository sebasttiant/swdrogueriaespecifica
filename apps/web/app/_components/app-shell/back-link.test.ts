import { describe, expect, it } from "vitest";

import { parentPath } from "./back-link";

// --------------------------------------------------------------------------
// El destino del "volver" sale de la RUTA, no del historial del navegador.
// `router.back()` devuelve a donde el usuario venga —otro sitio, una página que
// ya no aplica—; una ruta padre siempre lleva al mismo lugar.
// --------------------------------------------------------------------------
describe("parentPath", () => {
  it("vuelve a la sección desde una pantalla anidada", () => {
    expect(parentPath("/pendientes/abc123/editar")).toBe("/pendientes");
    expect(parentPath("/productos/xyz")).toBe("/productos");
    expect(parentPath("/admin/user-1")).toBe("/admin");
  });

  // En el primer nivel la navegación ya está a la vista —barra lateral en
  // escritorio, barra inferior en celular—: un "volver" ahí sería un botón de
  // más compitiendo con ella.
  it("no ofrece volver desde una pantalla de primer nivel", () => {
    expect(parentPath("/pendientes")).toBeNull();
    expect(parentPath("/dashboard")).toBeNull();
    expect(parentPath("/")).toBeNull();
  });

  it("tolera barras de más sin inventar una ruta rara", () => {
    expect(parentPath("/pendientes/abc/editar/")).toBe("/pendientes");
    expect(parentPath("//productos//xyz")).toBe("/productos");
  });
});

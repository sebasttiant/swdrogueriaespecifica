import { describe, expect, it } from "vitest";

import { can } from "@/lib/auth/permissions";
import type { SessionRole } from "@/lib/auth/session";

// --------------------------------------------------------------------------
// Quién puede editar el catálogo.
//
// La capability que gobierna esto —`canManageProducts`— ya existía y ya tenía
// exactamente los tres roles pedidos. Esta prueba NO cambia permisos: los fija,
// para que ampliar la pantalla de producto no se convierta en una ampliación
// silenciosa de quién puede tocar el catálogo.
//
// El catálogo es información compartida: quien lo edita se lo cambia a todos.
// --------------------------------------------------------------------------

const PUEDEN: SessionRole[] = ["BODEGA", "ADMIN", "SUPERADMIN"];
const NO_PUEDEN: SessionRole[] = ["OPERADOR", "SUPERVISOR"];

describe("edición de catálogo · quién puede", () => {
  it.each(PUEDEN)("%s administra el catálogo", (rol) => {
    expect(can(rol, "canManageProducts")).toBe(true);
  });

  it.each(NO_PUEDEN)("%s NO administra el catálogo", (rol) => {
    expect(can(rol, "canManageProducts")).toBe(false);
  });

  // SUPERVISOR ve productos pero no los edita: mirar y administrar son dos
  // permisos distintos, y confundirlos es como se filtran las autorizaciones.
  it("SUPERVISOR puede VER productos sin poder editarlos", () => {
    expect(can("SUPERVISOR", "canViewProductos")).toBe(true);
    expect(can("SUPERVISOR", "canManageProducts")).toBe(false);
  });

  // El vendedor no toca el catálogo por ninguna vía: ni verlo entero, ni
  // administrarlo.
  it("OPERADOR no llega al catálogo por ningún lado", () => {
    expect(can("OPERADOR", "canManageProducts")).toBe(false);
    expect(can("OPERADOR", "canViewProductos")).toBe(false);
  });
});

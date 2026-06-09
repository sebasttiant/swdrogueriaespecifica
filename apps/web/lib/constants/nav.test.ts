import { describe, expect, it } from "vitest";

import { NAV_ITEMS, visibleNavItems } from "./nav";

function labels(role: Parameters<typeof visibleNavItems>[0]): string[] {
  return visibleNavItems(role).map((item) => item.label);
}

const ADMIN_ONLY_COUNT = NAV_ITEMS.filter((item) => item.adminOnly).length;

describe("visibleNavItems", () => {
  it("muestra los módulos admin (Usuarios, Auditoría) solo para ADMIN", () => {
    const admin = labels("ADMIN");
    expect(admin).toContain("Usuarios");
    expect(admin).toContain("Auditoría");
  });

  it("oculta los módulos admin a LIDER y OPERADOR", () => {
    for (const role of ["LIDER", "OPERADOR"] as const) {
      expect(labels(role)).not.toContain("Usuarios");
      expect(labels(role)).not.toContain("Auditoría");
    }
  });

  it("oculta items admin-only cuando no hay rol (sin sesión)", () => {
    expect(labels(null)).not.toContain("Usuarios");
    expect(labels(null)).not.toContain("Auditoría");
  });

  it("conserva los items operativos para cualquier rol", () => {
    const operador = labels("OPERADOR");
    expect(operador).toEqual(
      expect.arrayContaining(["Dashboard", "Pendientes", "Faltantes"]),
    );
    // Los no-admin ven todo menos los items admin-only.
    expect(operador).toHaveLength(NAV_ITEMS.length - ADMIN_ONLY_COUNT);
  });
});

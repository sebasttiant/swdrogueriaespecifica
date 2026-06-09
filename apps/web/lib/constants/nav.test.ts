import { describe, expect, it } from "vitest";

import { NAV_ITEMS, visibleNavItems } from "./nav";

function labels(role: Parameters<typeof visibleNavItems>[0]): string[] {
  return visibleNavItems(role).map((item) => item.label);
}

const ADMIN_ONLY_COUNT = NAV_ITEMS.filter((item) => item.adminOnly).length;

describe("visibleNavItems", () => {
  it("muestra los módulos admin (Usuarios, Auditoría) a SUPERADMIN y ADMIN", () => {
    for (const role of ["SUPERADMIN", "ADMIN"] as const) {
      expect(labels(role)).toContain("Usuarios");
      expect(labels(role)).toContain("Auditoría");
    }
  });

  it("oculta los módulos admin a OPERADOR", () => {
    expect(labels("OPERADOR")).not.toContain("Usuarios");
    expect(labels("OPERADOR")).not.toContain("Auditoría");
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

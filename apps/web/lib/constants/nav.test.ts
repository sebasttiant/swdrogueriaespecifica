import { describe, expect, it } from "vitest";

import { NAV_ITEMS, visibleNavItems } from "./nav";

function labels(role: Parameters<typeof visibleNavItems>[0]): string[] {
  return visibleNavItems(role).map((item) => item.label);
}

describe("visibleNavItems", () => {
  it("muestra Auditoría solo para ADMIN", () => {
    expect(labels("ADMIN")).toContain("Auditoría");
  });

  it("oculta Auditoría a LIDER y OPERADOR", () => {
    expect(labels("LIDER")).not.toContain("Auditoría");
    expect(labels("OPERADOR")).not.toContain("Auditoría");
  });

  it("oculta items admin-only cuando no hay rol (sin sesión)", () => {
    expect(labels(null)).not.toContain("Auditoría");
  });

  it("conserva los items operativos para cualquier rol", () => {
    const operador = labels("OPERADOR");
    expect(operador).toEqual(
      expect.arrayContaining(["Dashboard", "Pendientes", "Faltantes"]),
    );
    // Solo Auditoría es admin-only hoy: el resto siempre visible.
    expect(operador).toHaveLength(NAV_ITEMS.length - 1);
  });
});

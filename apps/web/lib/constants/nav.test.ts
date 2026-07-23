import { describe, expect, it } from "vitest";

import { visibleNavItems } from "./nav";

function labels(role: Parameters<typeof visibleNavItems>[0]): string[] {
  return visibleNavItems(role).map((item) => item.label);
}

describe("visibleNavItems", () => {
  it("muestra los módulos sensibles (Reportes, Usuarios, Auditoría) a SUPERADMIN y ADMIN", () => {
    for (const role of ["SUPERADMIN", "ADMIN"] as const) {
      expect(labels(role)).toContain("Reportes");
      expect(labels(role)).toContain("Usuarios");
      expect(labels(role)).toContain("Auditoría");
    }
  });

  it("oculta los módulos sensibles a OPERADOR", () => {
    const operador = labels("OPERADOR");
    expect(operador).not.toContain("Reportes");
    expect(operador).not.toContain("Usuarios");
    expect(operador).not.toContain("Auditoría");
  });

  it("OPERADOR ve exactamente los cinco items operativos", () => {
    expect(labels("OPERADOR")).toEqual([
      "Dashboard",
      "Pendientes",
      "Faltantes",
      "Entradas",
      "Productos",
    ]);
  });

  it("SUPERVISOR ve items operativos, incluyendo Faltantes, sin administración", () => {
    const supervisor = labels("SUPERVISOR");
    expect(supervisor).toEqual([
      "Dashboard",
      "Pendientes",
      "Faltantes",
      "Entradas",
      "Productos",
    ]);
    expect(supervisor).not.toContain("Reportes");
    expect(supervisor).not.toContain("Usuarios");
    expect(supervisor).not.toContain("Auditoría");
  });

  it("sin sesión (rol nulo) no se muestra nada", () => {
    expect(labels(null)).toEqual([]);
    expect(labels(undefined)).toEqual([]);
  });
});

describe("visibleNavItems · revisión de reportes", () => {
  // La cola de revisión es de gerencia: el vendedor que reporta no la ve.
  it("solo la ven SUPERADMIN y ADMIN", () => {
    expect(labels("SUPERADMIN")).toContain("Revisión de reportes");
    expect(labels("ADMIN")).toContain("Revisión de reportes");
    expect(labels("SUPERVISOR")).not.toContain("Revisión de reportes");
    expect(labels("OPERADOR")).not.toContain("Revisión de reportes");
  });

  // La barra inferior del celular es del flujo operativo; una vista de gerencia
  // no debe robarle un lugar.
  it("no ocupa un lugar en la barra inferior móvil", () => {
    const item = visibleNavItems("ADMIN").find(
      (navItem) => navItem.href === "/revision-faltantes",
    );
    expect(item).toBeDefined();
    expect(item?.primaryMobile).toBeUndefined();
  });
});

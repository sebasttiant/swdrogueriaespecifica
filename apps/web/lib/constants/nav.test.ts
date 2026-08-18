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

  it("OPERADOR ve exactamente los seis items operativos", () => {
    expect(labels("OPERADOR")).toEqual([
      "Dashboard",
      "Pendientes",
      "Faltantes",
      // Agregado por T4.2b·A: el vendedor revisa pendientes, acotado a los
      // suyos. No se quitó ninguno de los anteriores.
      "Revisión de pendientes",
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
      // Agregado por T4.2b·A. No se quitó ninguno de los anteriores.
      "Revisión de pendientes",
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
    expect(labels("SUPERADMIN")).toContain("Revisión de faltantes");
    expect(labels("ADMIN")).toContain("Revisión de faltantes");
    expect(labels("SUPERVISOR")).not.toContain("Revisión de faltantes");
    expect(labels("OPERADOR")).not.toContain("Revisión de faltantes");
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

describe("visibleNavItems · revisión de pendientes", () => {
  // A diferencia de la revisión de faltantes —que es solo de gerencia—, ésta la
  // usa TODO el que ya trabaja con pendientes: el vendedor revisa y gestiona los
  // suyos, gerencia los de todos. El módulo es el mismo; el recorte lo hace
  // `ownerId` en la capa de datos, no una pantalla distinta.
  it("la ven los roles que trabajan pendientes", () => {
    for (const role of ["SUPERADMIN", "ADMIN", "SUPERVISOR", "OPERADOR"] as const) {
      expect(labels(role)).toContain("Revisión de pendientes");
    }
  });

  // BODEGA es recepción física: deliberadamente sin pendientes ni datos de
  // cliente. Ojo al aseverar: buscar "BODEGA" en texto suelto da falso positivo
  // porque aparece dentro de LLEGO_BODEGA, un valor del eje de disponibilidad.
  it("BODEGA no la ve", () => {
    expect(labels("BODEGA")).not.toContain("Revisión de pendientes");
  });

  it("sin sesión no aparece", () => {
    expect(labels(null)).not.toContain("Revisión de pendientes");
  });

  // Misma regla que la revisión de faltantes: la barra inferior del celular es
  // del flujo operativo y una vista de revisión no debe robarle un lugar.
  it("no ocupa un lugar en la barra inferior móvil", () => {
    const item = visibleNavItems("ADMIN").find(
      (navItem) => navItem.href === "/revision-pendientes",
    );
    expect(item).toBeDefined();
    expect(item?.primaryMobile).toBeUndefined();
  });
});

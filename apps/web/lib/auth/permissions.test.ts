import { describe, expect, it } from "vitest";

import {
  assignableRolesFor,
  can,
  canAssignRole,
  canManageUserWithRole,
  canResetPasswordOf,
  isAdminRole,
  isSuperAdminRole,
  isUserManager,
  rolesWithCapability,
  USER_ROLES,
} from "./permissions";

describe("assignableRolesFor", () => {
  it("SUPERADMIN puede asignar todos los roles", () => {
    expect(assignableRolesFor("SUPERADMIN")).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "SUPERVISOR",
      "OPERADOR",
    ]);
  });

  it("ADMIN puede asignar ADMIN, SUPERVISOR y OPERADOR, pero NO SUPERADMIN", () => {
    const roles = assignableRolesFor("ADMIN");
    expect(roles).toEqual(["ADMIN", "SUPERVISOR", "OPERADOR"]);
    expect(roles).not.toContain("SUPERADMIN");
  });

  it("SUPERVISOR no puede asignar ningún rol (no gestiona usuarios)", () => {
    expect(assignableRolesFor("SUPERVISOR")).toEqual([]);
  });

  it("OPERADOR no puede asignar ningún rol (no gestiona usuarios)", () => {
    expect(assignableRolesFor("OPERADOR")).toEqual([]);
  });
});

describe("canAssignRole", () => {
  it("permite que un ADMIN asigne el rol ADMIN (su propia tier)", () => {
    expect(canAssignRole("ADMIN", "ADMIN")).toBe(true);
  });

  it("permite que un ADMIN asigne SUPERVISOR (tier inferior)", () => {
    expect(canAssignRole("ADMIN", "SUPERVISOR")).toBe(true);
  });

  it("rechaza que un ADMIN asigne SUPERADMIN (tier reservada al dueño técnico)", () => {
    expect(canAssignRole("ADMIN", "SUPERADMIN")).toBe(false);
  });

  it("permite que un SUPERADMIN asigne SUPERADMIN", () => {
    expect(canAssignRole("SUPERADMIN", "SUPERADMIN")).toBe(true);
  });

  it("un OPERADOR no puede asignar ningún rol (no gestiona usuarios)", () => {
    expect(canAssignRole("OPERADOR", "OPERADOR")).toBe(false);
  });

  it("un SUPERVISOR no puede asignar roles aunque supere a OPERADOR", () => {
    expect(canAssignRole("SUPERVISOR", "OPERADOR")).toBe(false);
  });
});

describe("canManageUserWithRole", () => {
  it("permite que un ADMIN gestione a otro ADMIN (su propia tier)", () => {
    expect(canManageUserWithRole("ADMIN", "ADMIN")).toBe(true);
  });

  it("rechaza que un ADMIN gestione a un SUPERADMIN", () => {
    expect(canManageUserWithRole("ADMIN", "SUPERADMIN")).toBe(false);
  });

  it("permite que un SUPERADMIN gestione a otro SUPERADMIN", () => {
    expect(canManageUserWithRole("SUPERADMIN", "SUPERADMIN")).toBe(true);
  });

  it("permite que un SUPERADMIN gestione a un ADMIN", () => {
    expect(canManageUserWithRole("SUPERADMIN", "ADMIN")).toBe(true);
  });

  it("permite que un ADMIN gestione a un SUPERVISOR", () => {
    expect(canManageUserWithRole("ADMIN", "SUPERVISOR")).toBe(true);
  });

  it("rechaza que un SUPERVISOR gestione usuarios", () => {
    expect(canManageUserWithRole("SUPERVISOR", "OPERADOR")).toBe(false);
    expect(canManageUserWithRole("SUPERVISOR", "SUPERVISOR")).toBe(false);
  });
});

describe("canResetPasswordOf", () => {
  it("permite cambiar la contraseña propia", () => {
    expect(canResetPasswordOf("ADMIN", "ADMIN", true)).toBe(true);
    expect(canResetPasswordOf("OPERADOR", "OPERADOR", true)).toBe(true);
  });

  it("permite que SUPERADMIN cambie la contraseña de cualquier rol", () => {
    expect(canResetPasswordOf("SUPERADMIN", "SUPERADMIN", false)).toBe(true);
    expect(canResetPasswordOf("SUPERADMIN", "ADMIN", false)).toBe(true);
    expect(canResetPasswordOf("SUPERADMIN", "SUPERVISOR", false)).toBe(true);
    expect(canResetPasswordOf("SUPERADMIN", "OPERADOR", false)).toBe(true);
  });

  it("permite que ADMIN cambie contraseñas de roles inferiores, no de pares", () => {
    expect(canResetPasswordOf("ADMIN", "SUPERVISOR", false)).toBe(true);
    expect(canResetPasswordOf("ADMIN", "OPERADOR", false)).toBe(true);
    expect(canResetPasswordOf("ADMIN", "ADMIN", false)).toBe(false);
  });

  it("rechaza que SUPERVISOR cambie contraseñas de otros usuarios", () => {
    expect(canResetPasswordOf("SUPERVISOR", "OPERADOR", false)).toBe(false);
  });

  it("rechaza objetivos fuera del techo de gestión", () => {
    expect(canResetPasswordOf("ADMIN", "SUPERADMIN", false)).toBe(false);
    expect(canResetPasswordOf("OPERADOR", "ADMIN", false)).toBe(false);
  });
});

describe("isAdminRole / isSuperAdminRole / isUserManager", () => {
  it("reconoce SUPERADMIN y ADMIN como administrativos, no a SUPERVISOR/OPERADOR", () => {
    expect(isAdminRole("SUPERADMIN")).toBe(true);
    expect(isAdminRole("ADMIN")).toBe(true);
    expect(isAdminRole("SUPERVISOR")).toBe(false);
    expect(isAdminRole("OPERADOR")).toBe(false);
  });

  it("isSuperAdminRole solo reconoce a SUPERADMIN", () => {
    expect(isSuperAdminRole("SUPERADMIN")).toBe(true);
    expect(isSuperAdminRole("ADMIN")).toBe(false);
    expect(isSuperAdminRole("SUPERVISOR")).toBe(false);
    expect(isSuperAdminRole("OPERADOR")).toBe(false);
  });

  it("isUserManager gatea a los roles administrativos", () => {
    expect(isUserManager("SUPERADMIN")).toBe(true);
    expect(isUserManager("ADMIN")).toBe(true);
    expect(isUserManager("SUPERVISOR")).toBe(false);
    expect(isUserManager("OPERADOR")).toBe(false);
  });
});

describe("capabilities · can()", () => {
  it("SUPERADMIN y ADMIN pueden ver usuarios (capability canManageUsers)", () => {
    expect(can("SUPERADMIN", "canManageUsers")).toBe(true);
    expect(can("ADMIN", "canManageUsers")).toBe(true);
  });

  it("OPERADOR tiene solo las capabilities operativas", () => {
    expect(can("OPERADOR", "canViewDashboard")).toBe(true);
    expect(can("OPERADOR", "canViewPendientes")).toBe(true);
    expect(can("OPERADOR", "canViewFaltantes")).toBe(true);
    expect(can("OPERADOR", "canViewProductos")).toBe(true);
    expect(can("OPERADOR", "canViewEntradas")).toBe(true);
    expect(can("OPERADOR", "canCreatePendientes")).toBe(true);
    expect(can("OPERADOR", "canCreateEntries")).toBe(true);
  });

  it("OPERADOR NO tiene las capabilities sensibles", () => {
    expect(can("OPERADOR", "canViewReports")).toBe(false);
    expect(can("OPERADOR", "canViewAudit")).toBe(false);
    expect(can("OPERADOR", "canManageUsers")).toBe(false);
    expect(can("OPERADOR", "canConfirmMissingItems")).toBe(false);
    expect(can("OPERADOR", "canSnoozeAlerts")).toBe(false);
    expect(can("OPERADOR", "canManageProducts")).toBe(false);
  });

  it("canDeliverPendings: todos los roles operativos lo tienen", () => {
    expect(can("SUPERADMIN", "canDeliverPendings")).toBe(true);
    expect(can("ADMIN", "canDeliverPendings")).toBe(true);
    expect(can("SUPERVISOR", "canDeliverPendings")).toBe(true);
    expect(can("OPERADOR", "canDeliverPendings")).toBe(true);
  });

  it("canCancelPendings: OPERADOR queda excluido (cancelar rompe un compromiso con el cliente)", () => {
    expect(can("SUPERADMIN", "canCancelPendings")).toBe(true);
    expect(can("ADMIN", "canCancelPendings")).toBe(true);
    expect(can("SUPERVISOR", "canCancelPendings")).toBe(true);
    expect(can("OPERADOR", "canCancelPendings")).toBe(false);
  });

  it("SUPERVISOR tiene capabilities operativas y puede confirmar faltantes", () => {
    expect(can("SUPERVISOR", "canViewDashboard")).toBe(true);
    expect(can("SUPERVISOR", "canViewPendientes")).toBe(true);
    expect(can("SUPERVISOR", "canViewFaltantes")).toBe(true);
    expect(can("SUPERVISOR", "canViewProductos")).toBe(true);
    expect(can("SUPERVISOR", "canViewEntradas")).toBe(true);
    expect(can("SUPERVISOR", "canCreatePendientes")).toBe(true);
    expect(can("SUPERVISOR", "canCreateEntries")).toBe(true);
    expect(can("SUPERVISOR", "canConfirmMissingItems")).toBe(true);
    expect(can("SUPERVISOR", "canDeliverPendings")).toBe(true);
    expect(can("SUPERVISOR", "canCancelPendings")).toBe(true);
  });

  it("SUPERVISOR NO tiene capabilities administrativas, reportes, auditoría ni catálogo", () => {
    expect(can("SUPERVISOR", "canManageUsers")).toBe(false);
    expect(can("SUPERVISOR", "canViewReports")).toBe(false);
    expect(can("SUPERVISOR", "canViewAudit")).toBe(false);
    expect(can("SUPERVISOR", "canManageProducts")).toBe(false);
    expect(can("SUPERVISOR", "canSnoozeAlerts")).toBe(false);
  });

  // Identidad del proveedor: es MÁS restrictiva que la del cliente. Un
  // SUPERVISOR ve al cliente pero NO a quién le compra la droguería.
  it("canViewSupplierIdentity: solo ADMIN/SUPERADMIN; ni SUPERVISOR ni OPERADOR", () => {
    expect(can("OPERADOR", "canViewSupplierIdentity")).toBe(false);
    expect(can("SUPERVISOR", "canViewSupplierIdentity")).toBe(false);
    expect(can("ADMIN", "canViewSupplierIdentity")).toBe(true);
    expect(can("SUPERADMIN", "canViewSupplierIdentity")).toBe(true);
  });

  it("canViewCustomerIdentity: OPERADOR no la tiene; SUPERVISOR/ADMIN/SUPERADMIN sí", () => {
    expect(can("OPERADOR", "canViewCustomerIdentity")).toBe(false);
    expect(can("SUPERVISOR", "canViewCustomerIdentity")).toBe(true);
    expect(can("ADMIN", "canViewCustomerIdentity")).toBe(true);
    expect(can("SUPERADMIN", "canViewCustomerIdentity")).toBe(true);
  });
});

describe("canOrderMissingItems (capability)", () => {
  it("permite ordenar faltantes solo a SUPERADMIN y ADMIN", () => {
    expect(can("SUPERADMIN", "canOrderMissingItems")).toBe(true);
    expect(can("ADMIN", "canOrderMissingItems")).toBe(true);
    expect(can("SUPERVISOR", "canOrderMissingItems")).toBe(false);
    expect(can("OPERADOR", "canOrderMissingItems")).toBe(false);
  });
});

describe("canManageSuppliers (capability)", () => {
  it("permite crear proveedores nuevos solo a SUPERADMIN y ADMIN", () => {
    expect(can("SUPERADMIN", "canManageSuppliers")).toBe(true);
    expect(can("ADMIN", "canManageSuppliers")).toBe(true);
    expect(can("SUPERVISOR", "canManageSuppliers")).toBe(false);
    expect(can("OPERADOR", "canManageSuppliers")).toBe(false);
  });
});

describe("canCreateMissingItems (capability)", () => {
  it("permite cargar faltantes manuales solo a SUPERADMIN y ADMIN", () => {
    expect(can("SUPERADMIN", "canCreateMissingItems")).toBe(true);
    expect(can("ADMIN", "canCreateMissingItems")).toBe(true);
    expect(can("SUPERVISOR", "canCreateMissingItems")).toBe(false);
    expect(can("OPERADOR", "canCreateMissingItems")).toBe(false);
  });
});

describe("canSubmitMissingReports (capability)", () => {
  it("allows every role to report a missing product name", () => {
    expect(can("SUPERADMIN", "canSubmitMissingReports")).toBe(true);
    expect(can("ADMIN", "canSubmitMissingReports")).toBe(true);
    expect(can("SUPERVISOR", "canSubmitMissingReports")).toBe(true);
    expect(can("OPERADOR", "canSubmitMissingReports")).toBe(true);
  });

  it("does not grant operational roles management capabilities", () => {
    for (const role of ["SUPERVISOR", "OPERADOR"] as const) {
      expect(can(role, "canCreateMissingItems")).toBe(false);
      expect(can(role, "canOrderMissingItems")).toBe(false);
      expect(can(role, "canManageSuppliers")).toBe(false);
      expect(can(role, "canManageProducts")).toBe(false);
    }
  });
});

describe("canReviewMissingReports (capability)", () => {
  // Reviewing the seller-report queue is a management decision (which report
  // becomes a real faltante), so only ADMIN/SUPERADMIN get it — unlike
  // canSubmitMissingReports, which every role has.
  it("is management-only", () => {
    expect(can("SUPERADMIN", "canReviewMissingReports")).toBe(true);
    expect(can("ADMIN", "canReviewMissingReports")).toBe(true);
    expect(can("SUPERVISOR", "canReviewMissingReports")).toBe(false);
    expect(can("OPERADOR", "canReviewMissingReports")).toBe(false);
  });

  it("is exactly the ADMIN/SUPERADMIN set", () => {
    expect(rolesWithCapability("canReviewMissingReports")).toEqual([
      "SUPERADMIN",
      "ADMIN",
    ]);
  });
});

describe("rolesWithCapability", () => {
  it("preserva el orden de USER_ROLES", () => {
    expect(rolesWithCapability("canViewDashboard")).toEqual([...USER_ROLES]);
  });

  it("canViewReports solo la tienen los administradores", () => {
    expect(rolesWithCapability("canViewReports")).toEqual([
      "SUPERADMIN",
      "ADMIN",
    ]);
  });

  it("canConfirmMissingItems incluye SUPERVISOR sin incluir OPERADOR", () => {
    expect(rolesWithCapability("canConfirmMissingItems")).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "SUPERVISOR",
    ]);
  });

  it("canViewCustomerIdentity incluye SUPERVISOR sin incluir OPERADOR", () => {
    expect(rolesWithCapability("canViewCustomerIdentity")).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "SUPERVISOR",
    ]);
  });

  it("canDeliverPendings incluye a los cuatro roles (el mostrador entrega)", () => {
    expect(rolesWithCapability("canDeliverPendings")).toEqual([...USER_ROLES]);
  });

  it("canCancelPendings excluye a OPERADOR (cancelar necesita firma superior)", () => {
    expect(rolesWithCapability("canCancelPendings")).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "SUPERVISOR",
    ]);
  });

  it("canCreateMissingItems solo incluye a gerencia", () => {
    expect(rolesWithCapability("canCreateMissingItems")).toEqual([
      "SUPERADMIN",
      "ADMIN",
    ]);
  });
});

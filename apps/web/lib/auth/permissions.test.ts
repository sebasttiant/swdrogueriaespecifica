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
  seesAllPendings,
  USER_ROLES,
} from "./permissions";

describe("assignableRolesFor", () => {
  it("SUPERADMIN puede asignar todos los roles", () => {
    expect(assignableRolesFor("SUPERADMIN")).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "SUPERVISOR",
      "OPERADOR",
      "BODEGA",
    ]);
  });

  it("ADMIN puede asignar ADMIN, SUPERVISOR y OPERADOR, pero NO SUPERADMIN", () => {
    const roles = assignableRolesFor("ADMIN");
    expect(roles).toEqual(["ADMIN", "SUPERVISOR", "OPERADOR", "BODEGA"]);
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

  it("OPERADOR ve exactamente los cuatro módulos de su circuito", () => {
    // La lista completa, no una muestra: si mañana alguien le suma un módulo al
    // vendedor, tiene que romper acá y no descubrirse en producción.
    const modulos = [
      "canViewDashboard",
      "canViewPendientes",
      "canViewFaltantes",
      "canViewProductos",
      "canViewEntradas",
      "canViewReports",
      "canViewAudit",
    ] as const;

    const visibles = modulos.filter((m) => can("OPERADOR", m));
    expect(visibles).toEqual(["canViewDashboard", "canViewPendientes", "canViewFaltantes"]);
    // El cuarto lugar del menú es la revisión de pendientes, que no tiene
    // capability de "ver módulo" propia.
    expect(can("OPERADOR", "canReviewPendings")).toBe(true);
  });

  it("OPERADOR opera dentro de esos módulos", () => {
    expect(can("OPERADOR", "canCreatePendientes")).toBe(true);
    expect(can("OPERADOR", "canSubmitMissingReports")).toBe(true);
    expect(can("OPERADOR", "canDeliverPendings")).toBe(true);
  });

  it("OPERADOR queda fuera del circuito de recepción y del catálogo", () => {
    // Ni el módulo ni la acción: quitar solo la vista dejaría la Server Action
    // alcanzable para quien supiera invocarla.
    expect(can("OPERADOR", "canViewEntradas")).toBe(false);
    expect(can("OPERADOR", "canCreateEntries")).toBe(false);
    expect(can("OPERADOR", "canViewProductos")).toBe(false);
    expect(can("OPERADOR", "canManageProducts")).toBe(false);
  });

  it("OPERADOR NO tiene las capabilities sensibles", () => {
    expect(can("OPERADOR", "canViewReports")).toBe(false);
    expect(can("OPERADOR", "canViewAudit")).toBe(false);
    expect(can("OPERADOR", "canManageUsers")).toBe(false);
    expect(can("OPERADOR", "canConfirmMissingItems")).toBe(false);
    expect(can("OPERADOR", "canSnoozeAlerts")).toBe(false);
  });

  it("canDeliverPendings: todos los roles operativos + BODEGA lo tienen", () => {
    expect(can("SUPERADMIN", "canDeliverPendings")).toBe(true);
    expect(can("ADMIN", "canDeliverPendings")).toBe(true);
    expect(can("SUPERVISOR", "canDeliverPendings")).toBe(true);
    expect(can("OPERADOR", "canDeliverPendings")).toBe(true);
    expect(can("BODEGA", "canDeliverPendings")).toBe(true);
  });

  // El vendedor cancela SU pendiente: el cliente que desiste lo llama a él. Lo
  // que lo limita no es la capacidad sino el alcance —`canManageAllPendings`,
  // que no tiene—, y el service rechaza cualquier pendiente ajeno.
  it("canCancelPendings: la tiene el vendedor y bodega, pero solo sobre lo suyo", () => {
    expect(can("SUPERADMIN", "canCancelPendings")).toBe(true);
    expect(can("ADMIN", "canCancelPendings")).toBe(true);
    expect(can("SUPERVISOR", "canCancelPendings")).toBe(true);
    expect(can("OPERADOR", "canCancelPendings")).toBe(true);
    expect(can("OPERADOR", "canManageAllPendings")).toBe(false);
    expect(can("BODEGA", "canCancelPendings")).toBe(true);
    expect(can("BODEGA", "canManageAllPendings")).toBe(false);
  });

  it("SUPERVISOR tiene capabilities operativas y puede confirmar faltantes", () => {
    expect(can("SUPERVISOR", "canViewDashboard")).toBe(true);
    expect(can("SUPERVISOR", "canViewPendientes")).toBe(true);
    expect(can("SUPERVISOR", "canViewFaltantes")).toBe(true);
    expect(can("SUPERVISOR", "canViewProductos")).toBe(true);
    expect(can("SUPERVISOR", "canViewEntradas")).toBe(true);
    expect(can("SUPERVISOR", "canCreatePendientes")).toBe(true);
    // El circuito de recepción es de gerencia y bodega: la supervisión ve la
    // lista de entradas pero no registra.
    expect(can("SUPERVISOR", "canCreateEntries")).toBe(false);
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

  // Descargar la cola de faltantes: solo gerencia. Ver la cola en pantalla
  // (canViewFaltantes) lo tienen todos; llevársela a un archivo, no.
  it("canExportFaltantes: solo ADMIN/SUPERADMIN; ni SUPERVISOR ni OPERADOR", () => {
    expect(can("OPERADOR", "canExportFaltantes")).toBe(false);
    expect(can("SUPERVISOR", "canExportFaltantes")).toBe(false);
    expect(can("ADMIN", "canExportFaltantes")).toBe(true);
    expect(can("SUPERADMIN", "canExportFaltantes")).toBe(true);
    // El vendedor ve la cola pero no puede exportarla: son ejes distintos.
    expect(can("OPERADOR", "canViewFaltantes")).toBe(true);
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
    expect(can("BODEGA", "canSubmitMissingReports")).toBe(true);
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
    expect(rolesWithCapability("canViewDashboard")).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "SUPERVISOR",
      "OPERADOR",
      "BODEGA",
    ]);
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

  it("canDeliverPendings llega a todos los roles operativos + BODEGA", () => {
    expect(rolesWithCapability("canDeliverPendings")).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "SUPERVISOR",
      "OPERADOR",
      "BODEGA",
    ]);
  });

  it("canCancelPendings llega al vendedor y a bodega, sin alcance global", () => {
    expect(rolesWithCapability("canCancelPendings")).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "SUPERVISOR",
      "OPERADOR",
      "BODEGA",
    ]);
  });

  it("canCreateMissingItems solo incluye a gerencia", () => {
    expect(rolesWithCapability("canCreateMissingItems")).toEqual([
      "SUPERADMIN",
      "ADMIN",
    ]);
  });
});

// --------------------------------------------------------------------------
// Alcance de pendientes. `canManageAllPendings` decide si la lista se acota a
// las filas propias, así que quitarla a un rol no le recorta una acción: le
// esconde la cola entera. SUPERVISOR ya entregaba y cancelaba pendientes de
// cualquiera, y tiene que seguir viéndolos.
// --------------------------------------------------------------------------
describe("canManageAllPendings (alcance de la cola)", () => {
  it("la tienen los administradores y la supervisión, nunca el vendedor", () => {
    expect(rolesWithCapability("canManageAllPendings")).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "SUPERVISOR",
    ]);
  });

  it("el vendedor solo puede contactar y facturar lo suyo", () => {
    expect(can("OPERADOR", "canContactOwnPendings")).toBe(true);
    expect(can("OPERADOR", "canInvoiceOwnPendings")).toBe(true);
    expect(can("OPERADOR", "canManageAllPendings")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Matriz BODEGA (T4.4). La bodega pasó de "solo catálogo" a operar a nivel
// vendedor: registra su operación (entradas, pendientes propios, faltantes),
// revisa su propia cola y ejecuta las acciones de cumplimiento sobre lo suyo.
// Quedan afuera la PII del cliente, la cola ajena y la lectura global.
// --------------------------------------------------------------------------
describe("BODEGA (matriz de perfil)", () => {
  it("opera a nivel vendedor: tiene las capacidades de alcance propio", () => {
    for (const capability of [
      "canViewDashboard",
      "canViewPendientes",
      "canViewFaltantes",
      "canViewProductos",
      "canViewEntradas",
      "canCreateEntries",
      // Gestión de catálogo: la bodega recibe mercadería que no siempre nace de
      // un faltante, y si el producto no está en el catálogo necesita crearlo
      // para poder registrar la recepción.
      "canManageProducts",
      "canCreatePendientes",
      "canSubmitMissingReports",
      "canContactOwnPendings",
      "canInvoiceOwnPendings",
      "canDeliverPendings",
      "canCancelPendings",
      "canReviewPendings",
    ] as const) {
      expect(can("BODEGA", capability)).toBe(true);
    }
  });

  it("queda SIN exposición de PII, cola ajena ni lectura global", () => {
    for (const capability of [
      "canViewCustomerIdentity",
      "canManageAllPendings",
      "canReadAllPendings",
    ] as const) {
      expect(can("BODEGA", capability)).toBe(false);
    }
  });
});

// --------------------------------------------------------------------------
// Eje de lectura global (T4.4). `canReadAllPendings` separa VER la cola entera
// de MUTAR pendientes ajenos: las superficies de lectura usan
// `canManageAllPendings || canReadAllPendings`, mientras que las acciones de
// cumplimiento siguen gateando SOLO con `canManageAllPendings`.
// --------------------------------------------------------------------------
describe("canReadAllPendings (lectura global ≠ mutación)", () => {
  it("la tienen administradores y supervisión, nunca vendedor ni bodega", () => {
    expect(rolesWithCapability("canReadAllPendings")).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "SUPERVISOR",
    ]);
    expect(can("OPERADOR", "canReadAllPendings")).toBe(false);
    expect(can("BODEGA", "canReadAllPendings")).toBe(false);
  });

  it("tener las acciones de vendedor NO otorga lectura global", () => {
    // BODEGA puede entregar/cancelar/facturar/contactar (lo suyo) pero no lee
    // la cola ajena: canReadAllPendings es un eje aparte de las acciones.
    expect(can("BODEGA", "canDeliverPendings")).toBe(true);
    expect(can("BODEGA", "canCancelPendings")).toBe(true);
    expect(can("BODEGA", "canReadAllPendings")).toBe(false);
    expect(can("BODEGA", "canManageAllPendings")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Quién ve los pendientes de TODOS y quién solo los suyos.
//
// Esta es la pregunta que hace el dueño de la droguería, y hasta ahora había
// que responderla leyendo dos capacidades y haciendo la cuenta a mano en cada
// pantalla. `seesAllPendings` la contesta en un solo lugar, y este bloque la
// fija por rol: una tabla, no una muestra.
// --------------------------------------------------------------------------
describe("seesAllPendings (alcance de la cola, en una sola regla)", () => {
  it("la cola completa es de gerencia y supervisión, nunca del vendedor", () => {
    const alcance = USER_ROLES.map((role) => [role, seesAllPendings(role)] as const);

    expect(alcance).toEqual([
      ["SUPERADMIN", true],
      ["ADMIN", true],
      ["SUPERVISOR", true],
      ["OPERADOR", false],
      ["BODEGA", false],
    ]);
  });

  it("el vendedor entra al módulo de revisión, pero acotado a lo suyo", () => {
    // Las dos mitades de la regla del negocio: puede revisar, y lo que revisa
    // son sus propios pendientes. Separarlas es lo que evita las dos fallas
    // opuestas —dejarlo afuera del módulo, o mostrarle la cola entera—.
    expect(can("OPERADOR", "canReviewPendings")).toBe(true);
    expect(seesAllPendings("OPERADOR")).toBe(false);
  });

  it("la supervisión revisa la cola entera", () => {
    expect(can("SUPERVISOR", "canReviewPendings")).toBe(true);
    expect(seesAllPendings("SUPERVISOR")).toBe(true);
  });

  it("cualquiera de los dos ejes alcanza para ver todo", () => {
    // La regla es una disyunción: alcanza con leer globalmente, aunque no se
    // pueda mutar. Si mañana se le quita la mutación a la supervisión, tiene
    // que seguir viendo la cola.
    for (const role of USER_ROLES) {
      expect(seesAllPendings(role)).toBe(
        can(role, "canManageAllPendings") || can(role, "canReadAllPendings"),
      );
    }
  });
});

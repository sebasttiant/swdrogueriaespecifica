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
import { SKU_CAPTURE_LINK_ROLES } from "@/server/domain/catalog/sku-identity";

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

  it("SUPERVISOR tiene capabilities operativas pero NO controla faltantes", () => {
    expect(can("SUPERVISOR", "canViewDashboard")).toBe(true);
    expect(can("SUPERVISOR", "canViewPendientes")).toBe(true);
    expect(can("SUPERVISOR", "canViewFaltantes")).toBe(true);
    expect(can("SUPERVISOR", "canViewProductos")).toBe(true);
    expect(can("SUPERVISOR", "canViewEntradas")).toBe(true);
    expect(can("SUPERVISOR", "canCreatePendientes")).toBe(true);
    // El circuito de recepción es de gerencia y bodega: la supervisión ve la
    // lista de entradas pero no registra.
    expect(can("SUPERVISOR", "canCreateEntries")).toBe(false);
    // Sobre faltantes solo REPORTA, igual que OPERADOR y BODEGA. Los controles
    // de Revisión de faltantes son de ADMIN/SUPERADMIN (decisión del 29-08-2026).
    expect(can("SUPERVISOR", "canSubmitMissingReports")).toBe(true);
    expect(can("SUPERVISOR", "canConfirmMissingItems")).toBe(false);
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

  // Ya no incluye SUPERVISOR: dar el OK sobre un faltante es un control de
  // Revisión de faltantes, y esos son de gerencia. Además no gateaba ninguna
  // superficie —toda acción de faltantes exige `canOrderMissingItems`—, así que
  // lo único que hacía era mostrarle un atajo que el guard después le negaba.
  it("canConfirmMissingItems es solo de gerencia", () => {
    expect(rolesWithCapability("canConfirmMissingItems")).toEqual([
      "SUPERADMIN",
      "ADMIN",
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

  // Bodega LEE la cola completa: es quien recibe la mercadería y necesita saber
  // qué espera cada vendedor para priorizar la descarga.
  it("lee la cola completa", () => {
    expect(can("BODEGA", "canReadAllPendings")).toBe(true);
  });

  // Leer no es operar, y ver la cola no es ver al cliente. Los dos ejes siguen
  // cerrados: bodega ve todos los pendientes y muta solo los suyos, sin acceso
  // a nombre ni teléfono de nadie.
  it("queda SIN exposición de PII ni poder sobre la cola ajena", () => {
    for (const capability of [
      "canViewCustomerIdentity",
      "canManageAllPendings",
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
  // Bodega entra a la lista: recibe la mercadería y necesita ver qué espera
  // cada vendedor para priorizar la descarga. El vendedor sigue afuera.
  it("la tienen gerencia, supervisión y bodega, nunca el vendedor", () => {
    expect(rolesWithCapability("canReadAllPendings")).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "SUPERVISOR",
      "BODEGA",
    ]);
    expect(can("OPERADOR", "canReadAllPendings")).toBe(false);
  });

  it("leer la cola entera NO otorga poder sobre ella", () => {
    // Los dos ejes siguen separados, y es el punto: bodega VE todos los
    // pendientes y solo puede MUTAR los suyos. Sus acciones de cumplimiento
    // siguen gateadas por `canManageAllPendings`, que no tiene.
    expect(can("BODEGA", "canReadAllPendings")).toBe(true);
    expect(can("BODEGA", "canDeliverPendings")).toBe(true);
    expect(can("BODEGA", "canCancelPendings")).toBe(true);
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
  it("la cola completa la ven todos menos el vendedor", () => {
    const alcance = USER_ROLES.map((role) => [role, seesAllPendings(role)] as const);

    expect(alcance).toEqual([
      ["SUPERADMIN", true],
      ["ADMIN", true],
      ["SUPERVISOR", true],
      ["OPERADOR", false],
      ["BODEGA", true],
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

// --------------------------------------------------------------------------
// Corregir la identidad de un producto es un eje PROPIO, y no un pedazo de
// `canManageProducts`.
//
// SUPERVISOR tiene que poder corregir un código de Orion mal cargado —es quien
// recibe el reclamo del vendedor— pero NO tiene que poder crear ni editar
// productos. Meterlo en `canManageProducts` para conseguir lo primero le
// regalaría lo segundo.
//
// Es el mismo criterio con el que ya están separados `canOrderMissingItems` y
// `canViewSupplierIdentity`: una acción y una exposición de datos que hoy viven
// en el mismo rol, pero que se pueden mover por separado.
// --------------------------------------------------------------------------
describe("canFixProductIdentity", () => {
  it("lo tienen quienes reciben o cargan el error: gerencia, supervisión y bodega", () => {
    expect(can("SUPERADMIN", "canFixProductIdentity")).toBe(true);
    expect(can("ADMIN", "canFixProductIdentity")).toBe(true);
    expect(can("SUPERVISOR", "canFixProductIdentity")).toBe(true);
    expect(can("BODEGA", "canFixProductIdentity")).toBe(true);
  });

  it("el vendedor no corrige el catálogo", () => {
    expect(can("OPERADOR", "canFixProductIdentity")).toBe(false);
  });

  // La razón de existir de esta capability: SUPERVISOR corrige SIN poder tocar
  // el resto del catálogo. Si algún día alguien la colapsa dentro de
  // `canManageProducts`, esta afirmación falla y explica por qué no se hace.
  it("SUPERVISOR corrige identidad pero sigue sin poder gestionar productos", () => {
    expect(can("SUPERVISOR", "canFixProductIdentity")).toBe(true);
    expect(can("SUPERVISOR", "canManageProducts")).toBe(false);
  });
});

// Vincular al capturar es un eje propio: lo tienen los mismos cinco que crean
// pendientes, y NO implica gestionar el catálogo.
describe("canLinkProductIdentity", () => {
  it("matches the capture domain authority exactly", () => {
    expect(rolesWithCapability("canLinkProductIdentity")).toEqual(SKU_CAPTURE_LINK_ROLES);
  });

  it("la tienen exactamente los cinco roles que crean pendientes", () => {
    expect(rolesWithCapability("canLinkProductIdentity")).toEqual(
      rolesWithCapability("canCreatePendientes"),
    );
  });

  it("no arrastra la gestión de catálogo", () => {
    expect(can("OPERADOR", "canLinkProductIdentity")).toBe(true);
    expect(can("OPERADOR", "canManageProducts")).toBe(false);
    expect(can("SUPERVISOR", "canLinkProductIdentity")).toBe(true);
    expect(can("SUPERVISOR", "canManageProducts")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Recibir NO es decidir qué se compra.
//
// Bodega necesita ver lo pedido para recibirlo. Darle `canReviewMissingReports`
// para lograrlo le entregaría de paso el poder de pedir y descartar — que es
// autoridad de compras, no de depósito. Por eso son dos ejes.
// --------------------------------------------------------------------------
describe("canReceiveMissingItems · recepción física", () => {
  it("la tienen bodega y gerencia", () => {
    expect(rolesWithCapability("canReceiveMissingItems")).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "BODEGA",
    ]);
  });

  // Decisión vigente: supervisión no recibe mercadería.
  it("SUPERVISOR y OPERADOR quedan afuera", () => {
    expect(can("SUPERVISOR", "canReceiveMissingItems")).toBe(false);
    expect(can("OPERADOR", "canReceiveMissingItems")).toBe(false);
  });

  it("recibir no arrastra autoridad de compras", () => {
    expect(can("BODEGA", "canReceiveMissingItems")).toBe(true);
    // `canDiscardMissingItems` todavía no existe como capability propia: el
    // descarte va con la autoridad de compras. Cuando se separe, entra acá.
    for (const compras of [
      "canReviewMissingReports",
      "canOrderMissingItems",
    ] as const) {
      expect(can("BODEGA", compras)).toBe(false);
    }
  });

  // La identidad del cliente no entra al depósito: para recibir una caja no
  // hace falta saber a quién se le vende.
  it("bodega sigue sin ver al cliente", () => {
    expect(can("BODEGA", "canViewCustomerIdentity")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Quién puede resolver el SKU de un producto.
//
// El mensaje que rechaza una entrada sin identidad manda a completarlo. Si el
// rol que recibe la caja no pudiera hacerlo, ese mensaje sería un callejón sin
// salida: la mercadería queda en el depósito sin poder cargarse y nadie sabe a
// quién pedirle qué.
// --------------------------------------------------------------------------
describe("resolver la identidad de un producto", () => {
  it("bodega puede: es quien tiene la caja con el código impreso", () => {
    expect(can("BODEGA", "canViewProductos")).toBe(true);
    expect(can("BODEGA", "canManageProducts")).toBe(true);
    expect(can("BODEGA", "canLinkProductIdentity")).toBe(true);
  });

  it("gerencia también", () => {
    for (const rol of ["ADMIN", "SUPERADMIN"] as const) {
      expect(can(rol, "canManageProducts")).toBe(true);
      expect(can(rol, "canLinkProductIdentity")).toBe(true);
    }
  });

  // El vendedor aplaza el SKU al tomar el pedido, pero no lo acuña: la
  // identidad se completa con el producto en la mano.
  it("el vendedor no gestiona el catálogo", () => {
    expect(can("OPERADOR", "canManageProducts")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// The faltantes split, stated once as a table.
//
// Business rule (2026-08-29): EVERY profile reports a missing product with the
// basic form. The Revisión de faltantes controls — order, confirm, discard,
// export — belong to ADMIN/SUPERADMIN and nobody else. BODEGA is the one
// exception on the receiving side: it does not buy, it receives.
// --------------------------------------------------------------------------
describe("faltantes · quién reporta y quién controla", () => {
  const EVERY_ROLE = ["SUPERADMIN", "ADMIN", "SUPERVISOR", "OPERADOR", "BODEGA"] as const;
  const MANAGEMENT_ONLY = [
    "canCreateMissingItems",
    "canOrderMissingItems",
    "canReviewMissingReports",
    "canConfirmMissingItems",
    "canExportFaltantes",
  ] as const;

  it("every profile reports", () => {
    for (const role of EVERY_ROLE) {
      expect(can(role, "canSubmitMissingReports")).toBe(true);
    }
  });

  it.each(MANAGEMENT_ONLY)("%s belongs to ADMIN/SUPERADMIN only", (capability) => {
    expect(rolesWithCapability(capability)).toEqual(["SUPERADMIN", "ADMIN"]);
  });

  // SUPERVISOR used to hold canConfirmMissingItems. It gated no surface —every
  // faltantes Server Action requires canOrderMissingItems, and
  // confirmMissingItemOk has no action at all— and its only visible effect was
  // revealing a shortcut to a screen whose guard then bounced the user back to
  // the dashboard. A capability that opens no door and grants no action is not
  // a permission, it is a trap.
  it("SUPERVISOR only reports, like every other operational role", () => {
    expect(can("SUPERVISOR", "canSubmitMissingReports")).toBe(true);
    for (const capability of MANAGEMENT_ONLY) {
      expect(can("SUPERVISOR", capability)).toBe(false);
    }
    // Nor may it enter the review screen: that guard is canReceiveMissingItems.
    expect(can("SUPERVISOR", "canReceiveMissingItems")).toBe(false);
  });

  // BODEGA receives boxes; it never decides what to buy.
  it("BODEGA receives but does not buy", () => {
    expect(can("BODEGA", "canReceiveMissingItems")).toBe(true);
    for (const capability of MANAGEMENT_ONLY) {
      expect(can("BODEGA", capability)).toBe(false);
    }
  });
});

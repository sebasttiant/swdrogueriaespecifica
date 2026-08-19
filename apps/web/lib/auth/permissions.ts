// --------------------------------------------------------------------------
// Role & permission logic — PURE and CLIENT-SAFE.
//
// This is the single source of truth for what each role is allowed to do. It
// imports ONLY the `SessionRole` type (no Prisma, no server code, no next/*),
// so it can be shared verbatim between client components and server code.
//
// TWO INDEPENDENT AXES — never derive one from the other:
//
//  1. CAPABILITIES answer "what may this role DO" (view a module, run an
//     action). Module access is driven exclusively by named capabilities via
//     the `ROLE_CAPABILITIES` matrix below — never by rank arithmetic. Adding a
//     new role means adding ONE row to that matrix; no page or action changes.
//
//  2. The RANK CEILING answers "whom may this role TOUCH" in user management.
//     An actor must NEVER create, assign, or mutate an account that outranks it,
//     or it could escalate by proxy and take over the system.
//
// Rank ceiling rule ("same tier or below, but the SUPERADMIN tier is reachable
// only from SUPERADMIN"):
//  - SUPERADMIN may manage/assign everything: SUPERADMIN, ADMIN, SUPERVISOR,
//    OPERADOR.
//  - ADMIN may manage/assign its own tier and below (ADMIN, SUPERVISOR, OPERADOR): an ADMIN
//    is a full administrator of the operational tier and may staff its own
//    level, so it CAN create/edit another ADMIN. It may NEVER create, edit,
//    deactivate, archive, or assign SUPERADMIN. WHY: the SUPERADMIN tier is
//    reserved for the technical owner of the system and must stay unreachable
//    from below — that is the one hard line the ceiling protects.
//  - Non-administrative roles (SUPERVISOR, OPERADOR) manage nobody.
// --------------------------------------------------------------------------

import type { SessionRole } from "./session";

// The single mirror of the Prisma `UserRole` enum. Any code that needs to
// enumerate roles (forms, filters, tests) should read this tuple.
export const USER_ROLES = [
  "SUPERADMIN",
  "ADMIN",
  "SUPERVISOR",
  "OPERADOR",
  "BODEGA",
] as const satisfies readonly SessionRole[];

// Administrative roles: may manage users and mutate the catalog. The system
// must never be left without at least one active (anti-lockout protection).
export const ADMIN_ROLES: readonly SessionRole[] = ["SUPERADMIN", "ADMIN"];

export function isAdminRole(role: SessionRole): boolean {
  return ADMIN_ROLES.includes(role);
}

export function isSuperAdminRole(role: SessionRole): boolean {
  return role === "SUPERADMIN";
}

// Whether this role is allowed to manage users AT ALL (the entry gate for the
// rank ceiling). Kept as its own function so callers express intent and the
// mapping can evolve without a find-and-replace. NOTE: this is distinct from
// the `"canManageUsers"` capability string used for module VIEW access — this
// predicate gates the user-management ceiling, not page visibility.
export function isUserManager(role: SessionRole): boolean {
  return isAdminRole(role);
}

// Rank ladder: higher number = more authority. This drives every ceiling check
// below. SUPERADMIN outranks ADMIN outranks SUPERVISOR outranks OPERADOR.
const ROLE_RANK: Record<SessionRole, number> = {
  SUPERADMIN: 4,
  ADMIN: 3,
  SUPERVISOR: 2,
  OPERADOR: 1,
  BODEGA: 1,
};

/**
 * The one predicate behind the whole rank ceiling. Both public ceiling
 * functions delegate to it so the rule lives in exactly one place.
 *
 *  - A non-manager (SUPERVISOR, OPERADOR) acts on nobody.
 *  - A manager may act on its own tier and below; the SUPERADMIN tier is
 *    reachable only from SUPERADMIN, since `<=` never lets ADMIN reach it.
 */
function canActOnRole(actor: SessionRole, target: SessionRole): boolean {
  if (!isUserManager(actor)) return false; // SUPERVISOR/OPERADOR manage nobody
  return ROLE_RANK[target] <= ROLE_RANK[actor]; // your tier or below; SUPERADMIN is out of reach for ADMIN
}

/**
 * Whether `actor` may assign `target` as a role. Delegates to the ceiling: an
 * ADMIN can assign ADMIN, SUPERVISOR, or OPERADOR but NOT SUPERADMIN; a SUPERADMIN can assign
 * any role. This is the role you STAMP on an account.
 */
export function canAssignRole(actor: SessionRole, target: SessionRole): boolean {
  return canActOnRole(actor, target);
}

/** The roles `actor` is allowed to assign, preserving USER_ROLES order. */
export function assignableRolesFor(actor: SessionRole): readonly SessionRole[] {
  return USER_ROLES.filter((role) => canAssignRole(actor, role));
}

/**
 * Whether `actor` may manage (edit/deactivate/archive) an account whose current
 * role is `targetRole`. Delegates to the same ceiling: an ADMIN may manage
 * another ADMIN, a SUPERVISOR, or an OPERADOR, but never a SUPERADMIN account. This is the
 * account you TOUCH.
 */
export function canManageUserWithRole(
  actor: SessionRole,
  targetRole: SessionRole,
): boolean {
  return canActOnRole(actor, targetRole);
}

/**
 * Whether `actor` may reset/change the password of an account with `targetRole`.
 * This is intentionally stricter than profile edits: same-tier ADMIN edits are
 * allowed, but peer credential control is not.
 */
export function canResetPasswordOf(
  actor: SessionRole,
  targetRole: SessionRole,
  isSelf: boolean,
): boolean {
  if (isSelf) return true;
  if (!canActOnRole(actor, targetRole)) return false;
  if (actor === "SUPERADMIN") return true;
  return ROLE_RANK[targetRole] < ROLE_RANK[actor];
}

// --------------------------------------------------------------------------
// Capability layer — the "what may this role DO" axis.
//
// Module access and per-action gates are driven exclusively by these named
// capabilities. When a new role (e.g. SUPERVISOR) is introduced, it becomes a
// single new row in `ROLE_CAPABILITIES`; no page, action, or nav entry needs to
// change. NEVER derive a capability from a rank comparison, or vice versa.
// --------------------------------------------------------------------------

export const CAPABILITIES = [
  "canViewDashboard",
  "canViewPendientes",
  "canViewFaltantes",
  "canViewProductos",
  "canViewEntradas",
  "canViewReports",
  "canViewAudit",
  "canManageUsers",
  "canConfirmMissingItems",
  "canSnoozeAlerts",
  "canManageProducts",
  "canCreatePendientes",
  "canCreateEntries",
  // Reporting a name that is missing from stock is an operational observation,
  // not a catalog mutation or purchasing decision, so every role may do it.
  "canSubmitMissingReports",
  // Gates exposure of customer PII (the pending's `customerName`) wherever that
  // identity is reused: Pendientes, Faltantes, and Dashboard. Data minimization
  // default: the lowest operational role (OPERADOR) does NOT get it; SUPERVISOR
  // and above do.
  "canViewCustomerIdentity",
  // Gatea la exposición de la IDENTIDAD DEL PROVEEDOR (de qué depósito o
  // laboratorio llega cada producto) en Faltantes y en su export. Decisión de
  // negocio explícita: un vendedor no debe saber a quién le compra la droguería.
  //
  // Es un eje DISTINTO de `canOrderMissingItems`: pedir es una acción, ver de
  // quién se compra es exposición de datos. Hoy ambas viven en la gerencia, pero
  // separarlas permite que en el futuro alguien pueda pedir sin ver la cartera
  // de proveedores, o al revés, con un cambio de una línea en `ROLE_CAPABILITIES`.
  //
  // Mismo mecanismo que `canViewCustomerIdentity`: la minimización ocurre en el
  // SERVIDOR. Ocultar la columna en el render no alcanzaría —el nombre viajaría
  // igual en el payload y se leería desde el inspector del navegador—.
  "canViewSupplierIdentity",
  // Gatea la DESCARGA de la cola de faltantes (Excel / CSV / impresión a PDF).
  // Bajarse la lista completa a un archivo es una acción de gerencia, no de un
  // vendedor: el archivo se reenvía y se guarda fuera del sistema. Solo
  // ADMIN/SUPERADMIN.
  //
  // Es un eje DISTINTO de `canViewFaltantes` (que todos tienen para reportar y
  // operar): ver la cola en pantalla no es lo mismo que llevársela entera. El
  // corte real vive en la RUTA de export, no en el botón: esconder el botón
  // dejaría la URL accesible a cualquiera que la conozca.
  "canExportFaltantes",
  // Delivery lifecycle (Slice A). Asymmetric on purpose: delivering is the
  // counter operator's everyday job, so OPERADOR gets it too. Cancelling
  // breaks a commitment already made to a customer and needs a higher
  // signature, so OPERADOR is deliberately excluded — only SUPERVISOR and up.
  "canDeliverPendings",
  "canCancelPendings",
  // Gatea el pedido de un faltante a un proveedor. Hoy solo los gerentes
  // (ADMIN/SUPERADMIN) compran; llevar esta capacidad a otro rol es un
  // cambio de matriz (esta lista + `ROLE_CAPABILITIES`), nunca un cambio de código.
  "canOrderMissingItems",
  // Gatea la CREACIÓN de un proveedor nuevo al vuelo mientras se pide un
  // faltante. Es un eje DISTINTO de `canOrderMissingItems`: pedir a un
  // proveedor ya conocido e inventar uno nuevo son decisiones separadas. Hoy
  // ambas viven en la gerencia (ADMIN/SUPERADMIN), pero mantenerlas como dos
  // capacidades permite que en el futuro un SUPERVISOR pueda "pedir a
  // proveedores conocidos" SIN poder inventar proveedores nuevos: sería un
  // cambio de una línea en `ROLE_CAPABILITIES`, jamás un cambio de código.
  "canManageSuppliers",
  // Gatea la carga MANUAL de un faltante (uno que no nace de un pendiente sin
  // stock). Es un eje DISTINTO de `canOrderMissingItems`: decidir que algo falta
  // no es lo mismo que decidir comprarlo, y de `canConfirmMissingItems`: dar el
  // OK gerencia sobre un faltante existente no es crearlo. Hoy vive en la
  // gerencia (ADMIN/SUPERADMIN); habilitarla a SUPERVISOR sería una línea en
  // `ROLE_CAPABILITIES`, jamás un cambio de código.
  "canCreateMissingItems",
  // Gatea la COLA de revisión de reportes provisionales de vendedores. Revisar
  // qué reporte se convierte en un faltante real es una decisión de gerencia,
  // así que solo ADMIN/SUPERADMIN — es el eje opuesto de `canSubmitMissingReports`
  // (todos reportan; solo gerencia revisa). ADMIN/SUPERADMIN la heredan de
  // `[...CAPABILITIES]`; no se agrega a SUPERVISOR/OPERADOR.
  "canReviewMissingReports",
  "canManageAllPendings",
  // Gatea la LECTURA de la cola completa de pendientes (ver todas las filas,
  // no solo las propias). Es un eje DISTINTO de `canManageAllPendings`: leer
  // todo no autoriza a operar nada ajeno. Las superficies de lectura usan
  // `canManageAllPendings || canReadAllPendings`; las acciones de cumplimiento
  // siguen gateando SOLO con `canManageAllPendings`. Separar los ejes permite
  // que en el futuro un rol pueda supervisar la cola sin mutar pendientes
  // ajenos: un cambio de una línea en `ROLE_CAPABILITIES`, jamás de código.
  "canReadAllPendings",
  "canContactOwnPendings",
  "canInvoiceOwnPendings",
  // Gatea el MÓDULO de revisión de pendientes. A diferencia de
  // `canReviewMissingReports` —que es solo de gerencia porque decidir qué se
  // compra lo es—, revisar pendientes lo hace todo el que ya trabaja con ellos:
  // el vendedor sobre los suyos, gerencia sobre los de todos. El módulo es el
  // mismo; quién ve qué lo decide `ownerId` en la capa de datos, no una
  // pantalla distinta ni esta capacidad.
  "canReviewPendings",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

// Exhaustive capability matrix — the authoritative mapping of role → what it
// may do. SUPERADMIN and ADMIN currently share the full set; SUPERVISOR is the
// operational middle tier with missing-item confirmation and full-queue scope;
// OPERADOR is the basic operational subset; BODEGA operates at seller level
// over its own pendings (no customer PII, no foreign queue, no global read).
// Neither operational role gets reports/audit/user-management, snooze, or
// catalog management.
const ROLE_CAPABILITIES: Record<SessionRole, readonly Capability[]> = {
  SUPERADMIN: [...CAPABILITIES],
  ADMIN: [...CAPABILITIES],
  SUPERVISOR: [
    "canViewDashboard",
    "canViewPendientes",
    "canViewFaltantes",
    "canViewProductos",
    "canViewEntradas",
    "canCreatePendientes",
    "canCreateEntries",
    "canSubmitMissingReports",
    "canConfirmMissingItems",
    "canViewCustomerIdentity",
    // Supervisión: ve y opera la cola completa, no solo lo que registró. Ya
    // entregaba y cancelaba pendientes de cualquiera antes de que existiera el
    // alcance por vendedor; sin esta capacidad el alcance lo habría encerrado
    // en sus propias filas.
    "canManageAllPendings",
    // La supervisión también tiene el eje de LECTURA global explícito: hoy es
    // redundante con canManageAllPendings en las superficies de lectura, pero
    // declara la intención y deja el eje listo si mañana se le quita la mutación.
    "canReadAllPendings",
    "canDeliverPendings",
    "canCancelPendings",
    "canReviewPendings",
  ],
  OPERADOR: [
    "canViewDashboard",
    "canViewPendientes",
    "canViewFaltantes",
    "canViewProductos",
    "canViewEntradas",
    "canCreatePendientes",
    "canCreateEntries",
    "canSubmitMissingReports",
    "canContactOwnPendings",
    "canInvoiceOwnPendings",
    "canDeliverPendings",
    // Cancelar SU pendiente: el cliente que desistió es suyo y la llamada la
    // recibe él. El alcance lo pone `canManageAllPendings`, que el vendedor no
    // tiene: el service rechaza cualquier pendiente ajeno.
    "canCancelPendings",
    "canReviewPendings",
  ],
  // Recepción física a nivel vendedor (T4.4): la bodega opera su propio
  // circuito — registra entradas, crea y cumple SUS pendientes, reporta
  // faltantes y revisa su propia cola. Quedan fuera la PII del cliente
  // (`canViewCustomerIdentity`), la cola ajena (`canManageAllPendings`) y la
  // lectura global (`canReadAllPendings`): la bodega no ve ni opera pendientes
  // de vendedores.
  BODEGA: [
    "canViewDashboard",
    "canViewPendientes",
    "canViewFaltantes",
    "canViewProductos",
    "canViewEntradas",
    "canCreateEntries",
    "canCreatePendientes",
    "canSubmitMissingReports",
    "canContactOwnPendings",
    "canInvoiceOwnPendings",
    "canDeliverPendings",
    "canCancelPendings",
    "canReviewPendings",
  ],
};

/** Whether `role` holds `capability`. The single check for module/action access. */
export function can(role: SessionRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

/** The roles that hold `capability`, preserving USER_ROLES order. */
export function rolesWithCapability(
  capability: Capability,
): readonly SessionRole[] {
  return USER_ROLES.filter((role) => can(role, capability));
}

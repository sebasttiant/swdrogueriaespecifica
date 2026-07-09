// --------------------------------------------------------------------------
// Servicio de gestión de usuarios (server-only). Boundary de negocio del
// módulo Admin. Las reglas de seguridad de cuentas viven acá, nunca en la UI
// ni en la Server Action (que solo orquesta Zod, permisos y auditoría).
//
// Reglas (slice Admin):
//  - Crear/editar: toda contraseña recibida se hashea (argon2) antes de persistir.
//  - No autobloqueo: un admin no puede desactivarse ni degradarse a sí mismo.
//  - No dejar el sistema sin admin: no se puede desactivar/degradar al último
//    ADMIN activo.
//  - Solo desactivar/reactivar (no hard-delete): preserva trazabilidad (FK a
//    auditoría/pendientes) y es la política pedida.
// --------------------------------------------------------------------------

import { hashPassword } from "@/lib/auth/password";
import {
  canAssignRole,
  canManageUserWithRole,
  canResetPasswordOf,
  isAdminRole,
} from "@/lib/auth/permissions";
import type { SessionRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import type { UserRole } from "@/lib/generated/prisma/client";
import type { Paginated } from "@/lib/pagination";
import {
  archiveUser as archiveUserRow,
  createUser as createUserRow,
  findUserById,
  listUsers,
  lockActiveAdministratorIds,
  setUserActive as setUserActiveRow,
  unarchiveUser as unarchiveUserRow,
  updateUser as updateUserRow,
  type UserListItem,
} from "@/server/repositories/user.repository";

export type UserRuleCode =
  | "NOT_FOUND"
  | "SELF_DEACTIVATION"
  | "SELF_ROLE_CHANGE"
  | "LAST_ADMIN"
  | "SELF_ARCHIVE"
  | "ALREADY_ARCHIVED"
  | "NOT_ARCHIVED"
  | "PASSWORD_RESET_NOT_ALLOWED"
  | "ROLE_NOT_ASSIGNABLE"
  | "TARGET_OUTRANKS_ACTOR";

export type UpdateUserResult = {
  before: UserListItem;
  after: UserListItem;
  passwordUpdated: boolean;
};

// Error de regla de negocio: la Server Action lo mapea a un mensaje claro.
export class UserRuleError extends Error {
  constructor(public readonly code: UserRuleCode) {
    super(code);
    this.name = "UserRuleError";
  }
}

export function getUsers(params: {
  cursor?: string | null;
  take?: number;
  includeArchived?: boolean;
}): Promise<Paginated<UserListItem>> {
  return listUsers(params);
}

export function getUserById(id: string): Promise<UserListItem | null> {
  return findUserById(id);
}

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  actorRole: SessionRole;
}): Promise<UserListItem> {
  // Techo de rango: nadie puede crear una cuenta que lo supere. Falla ANTES del
  // hash para que un pedido rechazado no pague el costo de argon2.
  if (!canAssignRole(input.actorRole, input.role)) {
    throw new UserRuleError("ROLE_NOT_ASSIGNABLE");
  }
  const passwordHash = await hashPassword(input.password);
  return createUserRow({
    name: input.name,
    email: input.email,
    passwordHash,
    role: input.role,
  });
}

export async function updateUser(args: {
  id: string;
  actingUserId: string;
  actorRole: SessionRole;
  input: { name: string; email: string; role: UserRole; password?: string };
}): Promise<UpdateUserResult> {
  // ATÓMICO: lock de administradores activos + chequeo + update en una sola
  // transacción, para que dos demociones concurrentes no dejen el sistema sin
  // ningún administrador activo.
  return prisma.$transaction(async (tx) => {
    const target = await findUserById(args.id, tx);
    if (!target) throw new UserRuleError("NOT_FOUND");

    // Ceiling: no puede editar una cuenta que lo supera en rango, ni asignar un
    // rol superior al suyo (escalada por proxy).
    if (!canManageUserWithRole(args.actorRole, target.role)) {
      throw new UserRuleError("TARGET_OUTRANKS_ACTOR");
    }
    if (!canAssignRole(args.actorRole, args.input.role)) {
      throw new UserRuleError("ROLE_NOT_ASSIGNABLE");
    }
    const isSelf = args.id === args.actingUserId;
    const passwordUpdated = Boolean(args.input.password);
    if (
      passwordUpdated &&
      !canResetPasswordOf(args.actorRole, target.role, isSelf)
    ) {
      throw new UserRuleError("PASSWORD_RESET_NOT_ALLOWED");
    }

    // Degradación = pasar de un rol administrativo a uno no administrativo.
    const demotingFromAdmin =
      isAdminRole(target.role) && !isAdminRole(args.input.role);

    if (demotingFromAdmin) {
      if (isSelf) {
        throw new UserRuleError("SELF_ROLE_CHANGE");
      }
      if (target.active) {
        const adminIds = await lockActiveAdministratorIds(tx);
        if (adminIds.length <= 1) throw new UserRuleError("LAST_ADMIN");
      }
    }

    const passwordHash = args.input.password
      ? await hashPassword(args.input.password)
      : undefined;

    const after = await updateUserRow(
      args.id,
      {
        name: args.input.name,
        email: args.input.email,
        role: args.input.role,
        ...(passwordHash ? { passwordHash } : {}),
      },
      tx,
    );
    return { before: target, after, passwordUpdated };
  });
}

export async function setUserActive(args: {
  id: string;
  actingUserId: string;
  actorRole: SessionRole;
  active: boolean;
}): Promise<UserListItem> {
  // ATÓMICO: ver updateUser. La baja del último admin se serializa con el lock.
  return prisma.$transaction(async (tx) => {
    const target = await findUserById(args.id, tx);
    if (!target) throw new UserRuleError("NOT_FOUND");

    // El autobloqueo va ANTES del techo de rango porque una acción sobre la
    // propia cuenta merece el mensaje específico (SELF_DEACTIVATION), no el
    // genérico del techo.
    if (!args.active && args.id === args.actingUserId) {
      throw new UserRuleError("SELF_DEACTIVATION");
    }

    // Ceiling: un actor no puede cambiar el estado de una cuenta que lo supera
    // en rango (cierra el agujero "ADMIN desactiva al SUPERADMIN").
    if (!canManageUserWithRole(args.actorRole, target.role)) {
      throw new UserRuleError("TARGET_OUTRANKS_ACTOR");
    }

    // Solo las desactivaciones disparan la protección anti-lockout.
    if (!args.active) {
      if (isAdminRole(target.role) && target.active) {
        const adminIds = await lockActiveAdministratorIds(tx);
        if (adminIds.length <= 1) throw new UserRuleError("LAST_ADMIN");
      }
    }

    return setUserActiveRow(args.id, args.active, tx);
  });
}

/**
 * Archiva (soft-delete) un usuario. SUPERADMIN-only por contrato de la Action.
 *
 * Guards (en orden):
 *  - NOT_FOUND        → el usuario no existe.
 *  - SELF_ARCHIVE     → un admin no puede archivarse a sí mismo.
 *  - ALREADY_ARCHIVED → el usuario ya está archivado.
 *  - LAST_ADMIN       → no se puede archivar al último administrador activo.
 *
 * El archivado es ATÓMICO: dentro de la misma transacción se toma el lock de
 * administradores activos (si aplica) y se ejecuta el update que establece
 * `archivedAt` + `active=false` en una sola operación.
 */
export async function archiveUser(args: {
  id: string;
  actingUserId: string;
  actorRole: SessionRole;
}): Promise<UserListItem> {
  return prisma.$transaction(async (tx) => {
    const target = await findUserById(args.id, tx);
    if (!target) throw new UserRuleError("NOT_FOUND");

    // El autobloqueo va ANTES del techo de rango para dar el mensaje específico
    // (SELF_ARCHIVE) en vez del genérico del techo cuando la acción es sobre la
    // propia cuenta.
    if (args.id === args.actingUserId) {
      throw new UserRuleError("SELF_ARCHIVE");
    }

    // Ceiling: no puede archivar una cuenta que lo supera en rango. Hoy es
    // SUPERADMIN-only por la Action, así que es un no-op; queda como defensa en
    // profundidad si el guard de ruta se afloja.
    if (!canManageUserWithRole(args.actorRole, target.role)) {
      throw new UserRuleError("TARGET_OUTRANKS_ACTOR");
    }

    if (target.archivedAt !== null) {
      throw new UserRuleError("ALREADY_ARCHIVED");
    }

    // Protección anti-lockout: si el target es admin activo, verificar que no
    // sea el último. El lock serializa archivados concurrentes.
    if (isAdminRole(target.role) && target.active) {
      const adminIds = await lockActiveAdministratorIds(tx);
      if (adminIds.length <= 1) throw new UserRuleError("LAST_ADMIN");
    }

    return archiveUserRow(tx, args.id, new Date());
  });
}

/**
 * Restaura un usuario archivado: limpia `archivedAt` (→ null).
 * NO reactiva la cuenta (`active` permanece false); el admin reactivará
 * por separado si lo necesita. SUPERADMIN-only por contrato de la Action.
 *
 * Guards:
 *  - NOT_FOUND    → el usuario no existe.
 *  - NOT_ARCHIVED → el usuario no está archivado (operación sin sentido).
 */
export async function unarchiveUser(args: {
  id: string;
  actorRole: SessionRole;
}): Promise<UserListItem> {
  const target = await findUserById(args.id);
  if (!target) throw new UserRuleError("NOT_FOUND");

  // Ceiling: no puede restaurar una cuenta que lo supera en rango. Igual que
  // archiveUser, hoy es un no-op (SUPERADMIN-only) pero cierra la puerta si el
  // guard de ruta se afloja.
  if (!canManageUserWithRole(args.actorRole, target.role)) {
    throw new UserRuleError("TARGET_OUTRANKS_ACTOR");
  }

  if (target.archivedAt === null) {
    throw new UserRuleError("NOT_ARCHIVED");
  }

  // unarchiveUser no necesita lock (restaurar no reduce el conteo de admins).
  // Pasamos prisma como cliente base; el repositorio acepta TransactionClient.
  return unarchiveUserRow(prisma, args.id);
}

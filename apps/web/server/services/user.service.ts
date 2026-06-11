// --------------------------------------------------------------------------
// Servicio de gestión de usuarios (server-only). Boundary de negocio del
// módulo Admin. Las reglas de seguridad de cuentas viven acá, nunca en la UI
// ni en la Server Action (que solo orquesta Zod, permisos y auditoría).
//
// Reglas (slice Admin):
//  - Crear: la contraseña inicial se hashea (argon2) antes de persistir.
//  - No autobloqueo: un admin no puede desactivarse ni degradarse a sí mismo.
//  - No dejar el sistema sin admin: no se puede desactivar/degradar al último
//    ADMIN activo.
//  - Solo desactivar/reactivar (no hard-delete): preserva trazabilidad (FK a
//    auditoría/pendientes) y es la política pedida.
// --------------------------------------------------------------------------

import { hashPassword } from "@/lib/auth/password";
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
  | "NOT_ARCHIVED";

// Roles administrativos: pueden gestionar usuarios y mutar el catálogo. El
// sistema nunca puede quedar sin al menos uno activo (protección anti-lockout).
const ADMIN_ROLES: readonly UserRole[] = ["SUPERADMIN", "ADMIN"];
const isAdminRole = (role: UserRole): boolean => ADMIN_ROLES.includes(role);

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
}): Promise<UserListItem> {
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
  input: { name: string; email: string; role: UserRole };
}): Promise<UserListItem> {
  // ATÓMICO: lock de administradores activos + chequeo + update en una sola
  // transacción, para que dos demociones concurrentes no dejen el sistema sin
  // ningún administrador activo.
  return prisma.$transaction(async (tx) => {
    const target = await findUserById(args.id, tx);
    if (!target) throw new UserRuleError("NOT_FOUND");

    // Degradación = pasar de un rol administrativo a uno no administrativo.
    const demotingFromAdmin =
      isAdminRole(target.role) && !isAdminRole(args.input.role);

    if (demotingFromAdmin) {
      if (args.id === args.actingUserId) {
        throw new UserRuleError("SELF_ROLE_CHANGE");
      }
      if (target.active) {
        const adminIds = await lockActiveAdministratorIds(tx);
        if (adminIds.length <= 1) throw new UserRuleError("LAST_ADMIN");
      }
    }

    return updateUserRow(args.id, args.input, tx);
  });
}

export async function setUserActive(args: {
  id: string;
  actingUserId: string;
  active: boolean;
}): Promise<UserListItem> {
  // ATÓMICO: ver updateUser. La baja del último admin se serializa con el lock.
  return prisma.$transaction(async (tx) => {
    const target = await findUserById(args.id, tx);
    if (!target) throw new UserRuleError("NOT_FOUND");

    // Solo las desactivaciones disparan reglas de protección.
    if (!args.active) {
      if (args.id === args.actingUserId) {
        throw new UserRuleError("SELF_DEACTIVATION");
      }
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
}): Promise<UserListItem> {
  return prisma.$transaction(async (tx) => {
    const target = await findUserById(args.id, tx);
    if (!target) throw new UserRuleError("NOT_FOUND");

    if (args.id === args.actingUserId) {
      throw new UserRuleError("SELF_ARCHIVE");
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
}): Promise<UserListItem> {
  const target = await findUserById(args.id);
  if (!target) throw new UserRuleError("NOT_FOUND");

  if (target.archivedAt === null) {
    throw new UserRuleError("NOT_ARCHIVED");
  }

  // unarchiveUser no necesita lock (restaurar no reduce el conteo de admins).
  // Pasamos prisma como cliente base; el repositorio acepta TransactionClient.
  return unarchiveUserRow(prisma, args.id);
}

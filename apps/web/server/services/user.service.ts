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
  createUser as createUserRow,
  findUserById,
  listUsers,
  lockActiveAdminIds,
  setUserActive as setUserActiveRow,
  updateUser as updateUserRow,
  type UserListItem,
} from "@/server/repositories/user.repository";

export type UserRuleCode =
  | "NOT_FOUND"
  | "SELF_DEACTIVATION"
  | "SELF_ROLE_CHANGE"
  | "LAST_ADMIN";

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
  // ATÓMICO: lock de admins activos + chequeo + update en una sola transacción,
  // para que dos demociones concurrentes no dejen el sistema sin admin.
  return prisma.$transaction(async (tx) => {
    const target = await findUserById(args.id, tx);
    if (!target) throw new UserRuleError("NOT_FOUND");

    const demotingFromAdmin =
      target.role === "ADMIN" && args.input.role !== "ADMIN";

    if (demotingFromAdmin) {
      if (args.id === args.actingUserId) {
        throw new UserRuleError("SELF_ROLE_CHANGE");
      }
      if (target.active) {
        const adminIds = await lockActiveAdminIds(tx);
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
      if (target.role === "ADMIN" && target.active) {
        const adminIds = await lockActiveAdminIds(tx);
        if (adminIds.length <= 1) throw new UserRuleError("LAST_ADMIN");
      }
    }

    return setUserActiveRow(args.id, args.active, tx);
  });
}

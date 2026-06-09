// --------------------------------------------------------------------------
// Repositorio de usuarios — ÚNICO lugar que toca Prisma para `User`.
// Los services orquestan; este repo solo accede a datos.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import {
  clampTake,
  decodeCursor,
  encodeCursor,
  type Paginated,
} from "@/lib/pagination";
import type { Prisma, UserRole } from "@/lib/generated/prisma/client";

// Forma mínima que auth necesita: credenciales + datos de sesión.
export type UserCredentials = {
  id: string;
  email: string;
  name: string;
  role: "SUPERADMIN" | "ADMIN" | "OPERADOR";
  active: boolean;
  passwordHash: string | null;
};

export async function findActiveByEmail(
  email: string,
): Promise<UserCredentials | null> {
  return prisma.user.findFirst({
    where: { email, active: true },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      passwordHash: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Gestión de usuarios (ADMIN). NUNCA seleccionamos passwordHash en lecturas de
// listado/detalle: el hash no sale del boundary de credenciales.
// ---------------------------------------------------------------------------

export type UserListItem = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt: Date;
};

export type CreateUserData = {
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
};

export type UpdateUserData = {
  name: string;
  email: string;
  role: UserRole;
};

const LIST_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  createdAt: true,
} as const;

export async function listUsers(params: {
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<UserListItem>> {
  const take = clampTake(params.take);
  let cursorId = params.cursor ? decodeCursor(params.cursor) : null;

  // Cursor controlado por el usuario: si apunta a un id inexistente, lo
  // ignoramos y servimos la primera página (no dejamos que rompa el listado).
  if (cursorId) {
    const exists = await prisma.user.findUnique({
      where: { id: cursorId },
      select: { id: true },
    });
    if (!exists) cursorId = null;
  }

  const rows = await prisma.user.findMany({
    take: take + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: LIST_SELECT,
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.id) : null;

  return { items, nextCursor };
}

// `client` permite ejecutar dentro de una transacción (Prisma.$transaction);
// por defecto usa el singleton. Así el service compone lock + chequeo + update
// de forma atómica sin que el repo conozca la transacción.
export function findUserById(
  id: string,
  client: Prisma.TransactionClient = prisma,
): Promise<UserListItem | null> {
  return client.user.findUnique({ where: { id }, select: LIST_SELECT });
}

export function createUser(data: CreateUserData): Promise<UserListItem> {
  return prisma.user.create({ data, select: LIST_SELECT });
}

export function updateUser(
  id: string,
  data: UpdateUserData,
  client: Prisma.TransactionClient = prisma,
): Promise<UserListItem> {
  return client.user.update({ where: { id }, data, select: LIST_SELECT });
}

export function setUserActive(
  id: string,
  active: boolean,
  client: Prisma.TransactionClient = prisma,
): Promise<UserListItem> {
  return client.user.update({ where: { id }, data: { active }, select: LIST_SELECT });
}

/**
 * Bloquea (FOR UPDATE) las filas de usuarios ADMINISTRATIVOS (SUPERADMIN o
 * ADMIN) activos y devuelve sus ids. Debe llamarse DENTRO de una transacción:
 * el lock serializa demociones/bajas de administradores concurrentes, evitando
 * que dos requests dejen el sistema sin ningún administrador activo.
 * `count(*)` no admite FOR UPDATE, por eso seleccionamos filas y contamos en JS.
 */
export async function lockActiveAdministratorIds(
  client: Prisma.TransactionClient,
): Promise<string[]> {
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT id FROM users WHERE role IN ('SUPERADMIN', 'ADMIN') AND active = true FOR UPDATE
  `;
  return rows.map((row) => row.id);
}

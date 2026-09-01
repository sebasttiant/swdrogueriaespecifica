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
import type { UserStatusFilter } from "@/features/admin/filters";

// Forma mínima que auth necesita: credenciales + datos de sesión.
export type UserCredentials = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
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
  archivedAt: Date | null;
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
  passwordHash?: string;
};

const LIST_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  archivedAt: true,
  createdAt: true,
} as const;

/**
 * El filtro se arma en el WHERE, no en memoria.
 *
 * Traer todos los usuarios y filtrarlos en JavaScript funciona con veinte y
 * deja de funcionar sin avisar: la pagina sigue respondiendo, cada vez mas
 * lenta, hasta que un dia el listado tarda lo suficiente como para que nadie
 * lo use.
 *
 * `archived` son DOS VISTAS SEPARADAS, no una suma. Antes `includeArchived`
 * traia todos —activos y archivados juntos— bajo una etiqueta que decia "Ver
 * archivados". Un archivado es alguien que ya no opera: verlo mezclado entre
 * los activos reabre la confusion que el archivado existe para cerrar.
 *
 * La busqueda usa `contains` con `mode: "insensitive"`, que Prisma traduce a
 * `ILIKE`. Con decenas de usuarios el planificador resuelve por escaneo
 * secuencial y responde en microsegundos; un indice funcional para `name`
 * seria una migracion que hoy no compra nada. Cuando el padron crezca a miles,
 * ahi si, y con el plan de consulta delante.
 */
function buildWhere(params: {
  q?: string;
  role?: UserRole;
  status?: UserStatusFilter;
  archived?: boolean;
}): Prisma.UserWhereInput {
  const search = params.q?.trim();
  return {
    ...(params.archived ? { archivedAt: { not: null } } : { archivedAt: null }),
    ...(params.role ? { role: params.role } : {}),
    ...(params.status ? { active: params.status === "activos" } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
}

export async function listUsers(params: {
  cursor?: string | null;
  take?: number;
  q?: string;
  role?: UserRole;
  status?: UserStatusFilter;
  /** `true` = solo archivados. Ausente o `false` = solo la vista operativa. */
  archived?: boolean;
}): Promise<Paginated<UserListItem>> {
  const take = clampTake(params.take);
  const where = buildWhere(params);
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
    where,
    // Orden estable: `createdAt` puede repetirse entre dos altas del mismo
    // segundo, y ahi el `id` desempata. Sin el desempate, la misma consulta
    // puede devolver dos ordenes distintos y el cursor saltea o repite filas.
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
 *
 * Nota: como el archivado fuerza `active=false` atómicamente, los usuarios
 * archivados ya quedan excluidos por el filtro `active = true`. No es necesario
 * agregar un filtro adicional de `archivedAt IS NULL`.
 */
export async function lockActiveAdministratorIds(
  client: Prisma.TransactionClient,
): Promise<string[]> {
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT id FROM users WHERE role IN ('SUPERADMIN', 'ADMIN') AND active = true FOR UPDATE
  `;
  return rows.map((row) => row.id);
}

/**
 * Archiva un usuario: establece `archivedAt` (timestamp) y `active=false`
 * de forma atómica. Debe llamarse dentro de una transacción para que el
 * lock de administradores y este update sean una operación indivisible.
 */
export function archiveUser(
  client: Prisma.TransactionClient,
  id: string,
  archivedAt: Date,
): Promise<UserListItem> {
  return client.user.update({
    where: { id },
    data: { archivedAt, active: false },
    select: LIST_SELECT,
  });
}

/**
 * Restaura (un-archives) un usuario: limpia `archivedAt` (→ null).
 * NO modifica `active`: el adminstrador deberá reactivar la cuenta por
 * separado si lo necesita. Esta separación es intencional por diseño.
 */
export function unarchiveUser(
  client: Prisma.TransactionClient,
  id: string,
): Promise<UserListItem> {
  return client.user.update({
    where: { id },
    data: { archivedAt: null },
    select: LIST_SELECT,
  });
}

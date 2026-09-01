import { USER_ROLES } from "@/lib/auth/permissions";
import type { UserRole } from "@/lib/generated/prisma/client";

// --------------------------------------------------------------------------
// El contrato de filtros de Administración. UNA sola definición.
//
// Tres capas leen estos parámetros: la página los saca de la URL, el
// repositorio los aplica en el WHERE y los enlaces los vuelven a escribir.
// Cuando cada una interpreta a su manera, alcanza con que una discrepe para
// que la pantalla muestre algo distinto de lo que el enlace prometía —y eso
// no se descubre hasta que alguien pagina en la vista de archivados y aparece
// entre los activos, que es exactamente el defecto que este slice corrige.
//
// Nada de lo que llega acá es confiable: son parámetros de una URL que
// cualquiera puede escribir a mano. Lo inválido se DESCARTA y se cae al valor
// por defecto; nunca rompe la pantalla.
// --------------------------------------------------------------------------

/** Dominio cerrado. No existe un "todos": eso es no filtrar. */
export const USER_STATUS_FILTERS = ["activos", "inactivos"] as const;
export type UserStatusFilter = (typeof USER_STATUS_FILTERS)[number];

export type UserFilters = {
  /** Nombre o correo, ya normalizado. Ausente = no filtrar. */
  q?: string;
  role?: UserRole;
  status?: UserStatusFilter;
  /** `true` = ver SOLO archivados. Son dos vistas separadas, no una suma. */
  archived: boolean;
  cursor?: string;
};

/** Lo que Next entrega en `searchParams`: un valor, varios, o ninguno. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * Un parámetro repetido llega como arreglo, y no hay forma de saber cuál quiso
 * la persona. Se descarta en vez de adivinar: adivinar mal filtra por algo que
 * nadie pidió, y eso se lee como un dato faltante, no como un error.
 */
function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Espacios normalizados: se recortan los bordes y se colapsan los internos.
 *
 * "  ana   maria  " y "ana maria" son la misma búsqueda para quien la escribe.
 * Sin esto, un espacio de más devuelve cero resultados y parece que la persona
 * no existe.
 */
function normalizeQuery(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\s+/g, " ");
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseRole(value: string | undefined): UserRole | undefined {
  return USER_ROLES.includes(value as UserRole) ? (value as UserRole) : undefined;
}

function parseStatus(value: string | undefined): UserStatusFilter | undefined {
  return USER_STATUS_FILTERS.includes(value as UserStatusFilter)
    ? (value as UserStatusFilter)
    : undefined;
}

export function parseUserFilters(params: RawSearchParams): UserFilters {
  return {
    q: normalizeQuery(single(params.q)),
    role: parseRole(single(params.role)),
    status: parseStatus(single(params.status)),
    // Solo el literal "true" abre la vista de archivados. Cualquier otra cosa
    // deja la operativa, que es la que se espera al entrar.
    archived: single(params.archived) === "true",
    cursor: single(params.cursor),
  };
}

/** Orden estable: dos URLs con los mismos filtros son la misma cadena. */
export function serializeUserFilters(filters: UserFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.role) params.set("role", filters.role);
  if (filters.status) params.set("status", filters.status);
  if (filters.archived) params.set("archived", "true");
  if (filters.cursor) params.set("cursor", filters.cursor);
  return params.toString();
}

/**
 * El href de `/admin` con los filtros vigentes más los cambios que se pidan.
 *
 * REGLA: cambiar cualquier filtro DESCARTA el cursor. Un cursor es una posición
 * dentro de un conjunto de resultados; cambiado el conjunto, esa posición ya no
 * significa nada y la segunda página saldría de una lista que nadie está
 * mirando. Solo `adminPageHref(f, { cursor })` lo conserva, porque ahí lo que
 * cambia es justamente él.
 */
export function adminPageHref(
  filters: UserFilters,
  changes: Partial<UserFilters>,
): string {
  const cursorChanged = Object.hasOwn(changes, "cursor");
  const next: UserFilters = {
    ...filters,
    ...changes,
    ...(cursorChanged ? {} : { cursor: undefined }),
  };
  const query = serializeUserFilters(next);
  return query ? `/admin?${query}` : "/admin";
}

// --------------------------------------------------------------------------
// Guards de sesión y rol — NODE-ONLY (Server Components / Server Actions).
//
// El middleware ya bloquea rutas privadas a nivel transporte. Estos guards son
// la verificación fina por página/acción: exigir sesión y/o un rol concreto.
// `hasRole` es puro y testeable; los guards componen sesión + chequeo.
// NUNCA importar desde middleware (Edge) ni desde componentes cliente.
// --------------------------------------------------------------------------

import { redirect } from "next/navigation";

import { findUserById } from "@/server/repositories/user.repository";

import { DEFAULT_AUTHENTICATED_ROUTE, LOGIN_ROUTE } from "./config.edge";
import { getCurrentSession } from "./index.node";
import type { Session, SessionRole } from "./session";

export function hasRole(
  role: SessionRole,
  allowed: readonly SessionRole[],
): boolean {
  return allowed.includes(role);
}

/** Exige sesión válida; si no hay, redirige al login. */
export async function requireSession(): Promise<Session> {
  const session = await getCurrentSession();
  if (!session) redirect(LOGIN_ROUTE);
  return session;
}

/**
 * Exige sesión + uno de los roles permitidos.
 * Autenticado pero sin permiso → lo devolvemos a su home (no al login).
 */
export async function requireRole(
  ...allowed: SessionRole[]
): Promise<Session> {
  const session = await requireSession();
  if (!hasRole(session.user.role, allowed)) {
    redirect(DEFAULT_AUTHENTICATED_ROUTE);
  }
  return session;
}

/**
 * Guard DB-AUTHORITATIVE para operaciones sensibles (módulo Admin).
 *
 * `requireRole` autoriza desde el payload del JWT, que vive hasta 2h. Si un
 * usuario es degradado o desactivado, su token viejo todavía dice "ADMIN". Para
 * administrar usuarios eso es inaceptable: acá releemos rol y estado desde la
 * base en CADA request, y la sesión devuelta refleja el estado real.
 *
 *  - Sin sesión / usuario inexistente / inactivo → login (cuenta ida o cortada).
 *  - Autenticado pero sin el rol requerido → su home (no al login).
 */
export async function requireActiveRole(
  ...allowed: SessionRole[]
): Promise<Session> {
  const session = await getCurrentSession();
  if (!session) redirect(LOGIN_ROUTE);

  const user = await findUserById(session.user.id);
  // Rechazamos también usuarios archivados: aunque archive fuerza active=false,
  // este chequeo explícito es una red de seguridad de defensa en profundidad.
  if (!user || !user.active || user.archivedAt !== null) redirect(LOGIN_ROUTE);
  if (!hasRole(user.role, allowed)) redirect(DEFAULT_AUTHENTICATED_ROUTE);

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  };
}

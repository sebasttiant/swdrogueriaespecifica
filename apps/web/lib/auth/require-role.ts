// --------------------------------------------------------------------------
// Guards de sesión y rol — NODE-ONLY (Server Components / Server Actions).
//
// El middleware ya bloquea rutas privadas a nivel transporte. Estos guards son
// la verificación fina por página/acción: exigir sesión y/o un rol concreto.
// `hasRole` es puro y testeable; los guards componen sesión + chequeo.
// NUNCA importar desde middleware (Edge) ni desde componentes cliente.
// --------------------------------------------------------------------------

import { redirect } from "next/navigation";

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

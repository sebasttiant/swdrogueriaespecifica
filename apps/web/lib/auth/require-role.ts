// --------------------------------------------------------------------------
// Guards de sesión y rol — NODE-ONLY (Server Components / Server Actions).
//
// El middleware ya bloquea rutas privadas a nivel transporte. Estos guards son
// la verificación fina por página/acción: exigir sesión y/o un rol concreto.
// `hasRole` es puro y testeable; los guards componen sesión + chequeo.
// NUNCA importar desde middleware (Edge) ni desde componentes cliente.
// --------------------------------------------------------------------------

import { redirect } from "next/navigation";

import { can, type Capability } from "@/lib/auth/permissions";
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
 * Núcleo DB-AUTHORITATIVE compartido por todos los guards finos.
 *
 * El payload del JWT vive hasta 2h. Si un usuario es degradado o desactivado,
 * su token viejo todavía dice "ADMIN". Por eso releemos rol y estado desde la
 * base en CADA request y devolvemos una sesión que refleja el estado real.
 * Nunca autorices contra el payload del token.
 *
 *  - Sin sesión / usuario inexistente / inactivo / archivado → login.
 *
 * El chequeo específico (rol o capability) lo hace el guard que llama.
 */
async function requireLiveSession(): Promise<Session> {
  const session = await getCurrentSession();
  if (!session) redirect(LOGIN_ROUTE);

  const user = await findUserById(session.user.id);
  // Rechazamos también usuarios archivados: aunque archive fuerza active=false,
  // este chequeo explícito es una red de seguridad de defensa en profundidad.
  if (!user || !user.active || user.archivedAt !== null) redirect(LOGIN_ROUTE);

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  };
}

/**
 * Guard DB-AUTHORITATIVE por ROL. Relee estado desde la base (ver
 * `requireLiveSession`).
 *
 *  - Sin sesión / usuario inexistente / inactivo / archivado → login.
 *  - Autenticado pero sin el rol requerido → su home (no al login).
 */
export async function requireActiveRole(
  ...allowed: SessionRole[]
): Promise<Session> {
  const session = await requireLiveSession();
  if (!hasRole(session.user.role, allowed)) {
    redirect(DEFAULT_AUTHENTICATED_ROUTE);
  }
  return session;
}

/**
 * Guard DB-AUTHORITATIVE por CAPABILITY. Espeja a `requireActiveRole` pero gatea
 * por una capability nombrada en lugar de una lista de roles: el acceso a un
 * módulo se decide por lo que un rol PUEDE HACER, no por aritmética de rango.
 * Cuando se agregue un rol nuevo, basta con una fila en la matriz de
 * capabilities; este guard no cambia.
 *
 *  - Sin sesión / usuario inexistente / inactivo / archivado → login.
 *  - Autenticado pero sin la capability → su home (no al login).
 */
export async function requireCapability(
  capability: Capability,
): Promise<Session> {
  const session = await requireLiveSession();
  if (!can(session.user.role, capability)) {
    redirect(DEFAULT_AUTHENTICATED_ROUTE);
  }
  return session;
}

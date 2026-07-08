// --------------------------------------------------------------------------
// Punto de entrada de auth NODE-ONLY.
//
// Slice 1a: lee la cookie httpOnly de sesión y verifica el JWT (stateless, sin
// tocar la base). Es el ÚNICO lugar server-side donde se resuelve la sesión.
// NUNCA debe importarse desde `proxy.ts` (Edge) ni desde componentes
// cliente. El middleware verifica el token con `jwt.edge.ts` directamente.
// --------------------------------------------------------------------------

import { cookies } from "next/headers";

import { SESSION_COOKIE } from "./config.edge";
import { verifySession } from "./jwt.edge";
import type { Session } from "./session";

export async function getCurrentSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  return verifySession(token);
}

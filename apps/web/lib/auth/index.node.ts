// --------------------------------------------------------------------------
// Punto de entrada de auth NODE-ONLY.
//
// Fase 1: PLACEHOLDER. Devuelve `null` (no hay login implementado todavía).
// No importa Prisma a propósito, para no crear dependencias muertas.
//
// Fase 2/3: este módulo será el ÚNICO lugar que:
//   - lea la cookie httpOnly de sesión,
//   - verifique el token,
//   - cargue el usuario desde la base (vía `@/lib/db/prisma`),
//   - aplique hashing seguro de contraseñas.
// NUNCA debe importarse desde `middleware.ts` (Edge) ni desde componentes cliente.
// --------------------------------------------------------------------------

import type { Session } from "./session";

export async function getCurrentSession(): Promise<Session | null> {
  // TODO(Fase 2): leer cookie httpOnly, verificar y cargar usuario desde DB.
  return null;
}

// --------------------------------------------------------------------------
// Servicio de autenticación (server-only).
//
// Orquesta: busca el usuario (repo) y verifica la contraseña (argon2).
// Devuelve los datos mínimos de sesión o null. NO firma el JWT ni setea la
// cookie: eso es responsabilidad de la Server Action (que tiene el contexto
// de la request). La auditoría de login se cablea en el slice 1b.
// --------------------------------------------------------------------------

import { verifyPassword } from "@/lib/auth/password";
import type { SessionUser } from "@/lib/auth/session";
import { findActiveByEmail } from "@/server/repositories/user.repository";

export async function verifyCredentials(
  email: string,
  password: string,
): Promise<SessionUser | null> {
  const user = await findActiveByEmail(email);
  if (!user || !user.passwordHash) return null;

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) return null;

  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

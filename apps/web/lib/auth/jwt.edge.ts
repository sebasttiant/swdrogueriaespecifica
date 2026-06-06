// --------------------------------------------------------------------------
// JWT EDGE-SAFE (jose / Web Crypto).
//
// Por qué `jose` y no `jsonwebtoken`: `jsonwebtoken` depende de `crypto` de
// Node y NO corre en el runtime Edge del middleware. `jose` usa Web Crypto y
// funciona tanto en Edge como en Node — es el único lugar de firma/verificación.
//
// Sesión stateless: el JWT lleva SOLO datos mínimos (sub, email, name, role).
// Nada sensible. La verificación no toca la base de datos.
// --------------------------------------------------------------------------

import { jwtVerify, SignJWT } from "jose";

import type { Session, SessionRole, SessionUser } from "./session";

// Expiración corta (sesión stateless: sin refresh en esta fase).
const TOKEN_TTL = "2h";
const ALG = "HS256";

const ROLES: readonly SessionRole[] = ["ADMIN", "LIDER", "OPERADOR"];

// Se lee en runtime (no al cargar el módulo) para que el Edge y los tests
// puedan inyectar el valor sin reordenar imports.
function getSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET ausente o demasiado corto (mínimo 32 caracteres).",
    );
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: ALG })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(getSecretKey());
}

export async function verifySession(token: string): Promise<Session | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      algorithms: [ALG],
    });

    const { sub, email, name, role } = payload as Record<string, unknown>;
    if (
      typeof sub !== "string" ||
      typeof email !== "string" ||
      typeof name !== "string" ||
      typeof role !== "string" ||
      !ROLES.includes(role as SessionRole)
    ) {
      return null;
    }

    return { user: { id: sub, email, name, role: role as SessionRole } };
  } catch {
    // Firma inválida, expirado o malformado: sesión no válida.
    return null;
  }
}

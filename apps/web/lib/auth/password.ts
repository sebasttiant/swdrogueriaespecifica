// --------------------------------------------------------------------------
// Hashing de contraseñas — NODE-ONLY.
//
// Usa argon2 (estándar actual). `@node-rs/argon2` trae binarios precompilados,
// así que no requiere node-gyp ni rompe el build de Docker. Si en algún entorno
// el binario nativo no estuviera disponible, este es el único módulo a cambiar
// por `bcryptjs` (JS puro) sin tocar el resto del sistema.
//
// NUNCA importar desde middleware (Edge) ni desde componentes cliente.
// --------------------------------------------------------------------------

import { hash, verify } from "@node-rs/argon2";

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(
  passwordHash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    // Hash corrupto o formato inesperado: tratamos como credencial inválida.
    return false;
  }
}

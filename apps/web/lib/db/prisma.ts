import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client";
import { getServerEnv } from "../env";

// --------------------------------------------------------------------------
// Prisma 7 (rust-free) con driver adapter de Postgres.
// Singleton para evitar múltiples conexiones en dev (hot reload).
// Server-only: NUNCA importar esto desde middleware (Edge) ni componentes cliente.
//
// LAZY a propósito: la creación del cliente (y la validación fail-fast de env)
// se difiere al PRIMER USO real vía Proxy. Así `next build` puede importar
// módulos que dependen de Prisma sin requerir secretos en build; el cliente se
// crea recién en runtime, cuando DATABASE_URL ya está presente.
// --------------------------------------------------------------------------

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  const { DATABASE_URL } = getServerEnv();
  const adapter = new PrismaPg({ connectionString: DATABASE_URL });
  return new PrismaClient({ adapter });
}

let cached: PrismaClient | undefined;

function getPrismaClient(): PrismaClient {
  if (cached) return cached;
  cached = globalForPrisma.prisma ?? createPrismaClient();
  if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = cached;
  return cached;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getPrismaClient();
    const value = Reflect.get(client, prop);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

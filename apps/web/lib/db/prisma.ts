import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client";
import { getServerEnv } from "../env";

// --------------------------------------------------------------------------
// Prisma 7 (rust-free) con driver adapter de Postgres.
// Singleton para evitar múltiples conexiones en dev (hot reload).
// Server-only: NUNCA importar esto desde middleware (Edge) ni componentes cliente.
// --------------------------------------------------------------------------

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  const { DATABASE_URL } = getServerEnv();
  const adapter = new PrismaPg({ connectionString: DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

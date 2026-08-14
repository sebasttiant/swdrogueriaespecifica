import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, describe, expect, inject, it } from "vitest";

import { PrismaClient } from "@/lib/generated/prisma/client";

import { DISPOSABLE_DATABASE_PREFIX } from "./database-identity-guard";

// Gate del harness: si esto no pasa, ninguna prueba contra PostgreSQL de los
// slices siguientes vale nada. Verifica las cuatro garantías del harness:
// base descartable, aislada de la app, migrada y vacía.

const disposableDatabaseUrl = inject("disposableDatabaseUrl");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: disposableDatabaseUrl }),
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("harness de PostgreSQL aislado", () => {
  it("corre contra una base descartable", async () => {
    const [row] = await prisma.$queryRawUnsafe<{ current_database: string }[]>(
      "SELECT current_database()",
    );

    expect(row?.current_database).toMatch(
      new RegExp(`^${DISPOSABLE_DATABASE_PREFIX}`),
    );
  });

  // El código de la aplicación lee DATABASE_URL: si el harness no la
  // reemplaza, los tests de los próximos slices escribirían en la base real.
  it("apunta DATABASE_URL a la base descartable", () => {
    expect(process.env.DATABASE_URL).toBe(disposableDatabaseUrl);
  });

  it("aplica el historial completo de migraciones", async () => {
    const [row] = await prisma.$queryRawUnsafe<{ applied: number }[]>(
      'SELECT count(*)::int AS applied FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );

    expect(row?.applied).toBeGreaterThan(0);
  });

  it("deja el esquema operativo listo y vacío", async () => {
    await expect(prisma.pending.count()).resolves.toBe(0);
    await expect(prisma.productBatch.count()).resolves.toBe(0);
    await expect(prisma.missingItem.count()).resolves.toBe(0);
  });
});

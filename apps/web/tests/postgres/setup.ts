import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";
import type { TestProject } from "vitest/node";

import { PrismaClient } from "@/lib/generated/prisma/client";

import {
  assertDisposableBaseUrl,
  buildDisposableDatabaseUrl,
  createDisposableDatabaseName,
  quoteIdentifier,
} from "./database-identity-guard";

// --------------------------------------------------------------------------
// Ciclo de vida de la base descartable del gate de PostgreSQL.
//
// Cada corrida crea SU PROPIA base (`drogueria_test_<marca>`), le aplica el
// historial completo de migraciones y la borra al terminar, pase lo que pase.
// Nunca se reutiliza una base existente ni se borra nada que este harness no
// haya creado: de eso se encarga `database-identity-guard`.
//
// Requiere `TEST_DATABASE_URL` apuntando a un PostgreSQL descartable —por
// ejemplo el servicio de CI o un contenedor local—; sin esa variable el
// harness no corre.
// --------------------------------------------------------------------------

declare module "vitest" {
  interface ProvidedContext {
    disposableDatabaseUrl: string;
  }
}

const APP_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url));

export default async function setup({ provide }: TestProject) {
  const baseUrl = assertDisposableBaseUrl(process.env.TEST_DATABASE_URL, {
    nodeEnv: process.env.NODE_ENV,
    appDatabaseUrl: process.env.DATABASE_URL,
  });

  // Marca de tiempo (legible) + azar (irrepetible): dos corridas simultáneas
  // en la misma máquina no se pisan.
  const databaseName = createDisposableDatabaseName(
    `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
  );
  const disposableDatabaseUrl = buildDisposableDatabaseUrl(
    baseUrl.toString(),
    databaseName,
  );

  await withMaintenanceClient(baseUrl.toString(), (client) =>
    client.$executeRawUnsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`),
  );

  const dropDatabase = async () => {
    // FORCE cierra las conexiones que algún worker haya dejado abiertas; sin
    // eso el DROP falla y la base queda dando vueltas.
    await withMaintenanceClient(baseUrl.toString(), (client) =>
      client.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      ),
    );
  };

  try {
    applyMigrations(disposableDatabaseUrl);
  } catch (error) {
    // Si las migraciones fallan, la base a medio migrar se va igual.
    await dropDatabase();
    throw error;
  }

  provide("disposableDatabaseUrl", disposableDatabaseUrl);

  return dropDatabase;
}

async function withMaintenanceClient<T>(
  connectionString: string,
  run: (client: PrismaClient) => Promise<T>,
): Promise<T> {
  // `CREATE DATABASE` y `DROP DATABASE` no se pueden ejecutar dentro de una
  // transacción, así que van por `$executeRawUnsafe` con una única conexión.
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 1 }),
  });

  try {
    return await run(client);
  } finally {
    await client.$disconnect();
  }
}

function applyMigrations(databaseUrl: string): void {
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: APP_DIRECTORY,
    // Solo esta variable define el destino: la CLI de Prisma no puede caer a
    // la DATABASE_URL del entorno ni a un `.env` del repositorio.
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
}

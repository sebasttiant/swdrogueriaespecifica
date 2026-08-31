/**
 * Chequeo PREVIO al despliegue: ¿puede aplicarse la migración de identidad
 * canónica de laboratorios sin abortar?
 *
 * Es de SOLO LECTURA e idempotente: se puede correr las veces que haga falta,
 * en cualquier momento, contra producción, sin consecuencias. No aplica
 * migraciones, no escribe y no resuelve nada por su cuenta.
 *
 *   DATABASE_URL=postgresql://... pnpm --filter @drogueria/web db:preflight
 *
 * Códigos de salida, pensados para que `deploy.sh` los pueda distinguir:
 *
 *   0  la migración puede aplicarse
 *   1  hay identidades duplicadas: hay que resolverlas a mano ANTES de migrar
 *   2  no se pudo verificar (no hay conexión, falta DATABASE_URL, etc.)
 *
 * A diferencia de `db:verify`, este script NO es destructivo y no necesita
 * `ALLOW_DESTRUCTIVE_VERIFY`. Tampoco importa `@/lib/db/prisma`: ese módulo
 * valida el entorno completo de la aplicación (exige `AUTH_SECRET`), y un
 * preflight de base no tiene por qué pedir el secreto de sesión.
 */
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../lib/generated/prisma/client";
import {
  findIdentityConflicts,
  formatConflictReport,
} from "./laboratory-identity-preflight";

const EXIT_OK = 0;
const EXIT_CONFLICTS = 1;
const EXIT_UNVERIFIABLE = 2;

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("ERROR: falta DATABASE_URL. No se pudo verificar nada.");
    return EXIT_UNVERIFIABLE;
  }

  // Una sola conexión: `pg_temp` es de la sesión, y este chequeo es un SELECT.
  // No hay razón para pedirle cupo al pool de la aplicación.
  const client = new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 10_000,
    }),
  });

  try {
    // Transacción interactiva = una sola conexión de punta a punta, que es lo
    // que `pg_temp` necesita para que la función y el SELECT se vean.
    const conflicts = await client.$transaction((tx) =>
      findIdentityConflicts(tx),
    );

    if (conflicts.length === 0) {
      console.log(
        "OK: no hay identidades canónicas duplicadas en 'laboratories'.",
      );
      return EXIT_OK;
    }

    console.error(formatConflictReport(conflicts));
    return EXIT_CONFLICTS;
  } catch (error) {
    // Se informa el mensaje, nunca la URL de conexión: `DATABASE_URL` lleva la
    // contraseña de la base y este texto termina en el log del despliegue.
    console.error(
      "ERROR: no se pudo verificar la identidad canónica de laboratorios.",
    );
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_UNVERIFIABLE;
  } finally {
    await client.$disconnect();
  }
}

process.exitCode = await main();

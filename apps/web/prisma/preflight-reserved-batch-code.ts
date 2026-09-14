/**
 * Chequeo de datos: ¿hay lotes con el código RESERVADO mal escrito?
 *
 * Desde que el sistema deriva "SIN LOTE [fecha]" para una caja sin número de
 * lote, una fila con ese código que no sea la que el sistema habría escrito
 * afirma un vencimiento que no le corresponde. La regla y el detalle de por qué
 * importa están en `reserved-batch-code-preflight.ts`.
 *
 * Es de SOLO LECTURA e idempotente: se puede correr las veces que haga falta,
 * en cualquier momento, contra producción, sin consecuencias. No aplica
 * migraciones, no escribe y no resuelve nada por su cuenta.
 *
 *   DATABASE_URL=postgresql://... pnpm --filter @drogueria/web db:preflight:lotes
 *
 * Códigos de salida, pensados para que un despliegue los pueda distinguir:
 *
 *   0  no hay filas que revisar
 *   1  hay filas con el código reservado mal escrito: hay que resolverlas a mano
 *   2  no se pudo verificar (no hay conexión, falta DATABASE_URL, etc.)
 *
 * A diferencia de `db:verify`, este guion NO es destructivo y no necesita
 * `ALLOW_DESTRUCTIVE_VERIFY`. Tampoco importa `@/lib/db/prisma`: ese módulo
 * valida el entorno completo de la aplicación (exige `AUTH_SECRET`), y un
 * chequeo de base no tiene por qué pedir el secreto de sesión.
 */
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../lib/generated/prisma/client";
import {
  findReservedBatchCodeConflicts,
  formatReservedBatchCodeReport,
} from "./reserved-batch-code-preflight";

const EXIT_OK = 0;
const EXIT_CONFLICTS = 1;
const EXIT_UNVERIFIABLE = 2;

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("ERROR: falta DATABASE_URL. No se pudo verificar nada.");
    return EXIT_UNVERIFIABLE;
  }

  // Una sola conexión: esto es un SELECT. No hay razón para pedirle cupo al
  // pool de la aplicación.
  const client = new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 10_000,
    }),
  });

  try {
    const conflicts = await findReservedBatchCodeConflicts(client);

    if (conflicts.length === 0) {
      console.log(
        "OK: no hay lotes con el código reservado mal escrito en 'product_batches'.",
      );
      return EXIT_OK;
    }

    console.error(formatReservedBatchCodeReport(conflicts));
    return EXIT_CONFLICTS;
  } catch (error) {
    // Se informa el mensaje, nunca la URL de conexión: `DATABASE_URL` lleva la
    // contraseña de la base y este texto termina en el log del despliegue.
    console.error("ERROR: no se pudo verificar el código reservado de los lotes.");
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_UNVERIFIABLE;
  } finally {
    await client.$disconnect();
  }
}

process.exitCode = await main();

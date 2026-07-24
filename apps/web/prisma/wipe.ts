// --------------------------------------------------------------------------
// Blanqueo operativo: borra TODA la data (operación + catálogo) y CONSERVA la
// tabla `users`. Pensado para dejar la base lista para operar de cero después
// de una demo, sin perder las cuentas del equipo.
//
// DESTRUCTIVO E IRREVERSIBLE. Corre solo con la guarda explícita:
//     CONFIRM_WIPE=si
// Sin esa variable, aborta sin tocar nada. Los usuarios se borran aparte, a
// mano, desde la gestión de usuarios (super admin) — nunca acá.
// --------------------------------------------------------------------------

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client";
import { tablesToTruncate } from "./wipe-tables";

const CONFIRM = process.env.CONFIRM_WIPE;

async function main(): Promise<void> {
  if (CONFIRM !== "si") {
    console.error(
      "Blanqueo ABORTADO: falta la confirmación explícita.\n" +
        "Volvé a correrlo con  CONFIRM_WIPE=si  para borrar la operación " +
        "(los usuarios se conservan).",
    );
    process.exitCode = 1;
    return;
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL ?? "",
  });
  const prisma = new PrismaClient({ adapter });

  try {
    const usersBefore = await prisma.user.count();

    // Nombres reales de las tablas del schema public, tomados de la propia base
    // (no una lista hardcodeada que se desincronice del schema).
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    const targets = tablesToTruncate(rows.map((row) => row.tablename));

    if (targets.length === 0) {
      console.log("No hay tablas operativas para borrar. Nada que hacer.");
      return;
    }

    // TRUNCATE ... CASCADE respeta las FKs entre las tablas borradas. `users`
    // no está en `targets`, y CASCADE nunca sube de hijo a padre, así que la
    // tabla de usuarios queda intacta. RESTART IDENTITY resetea las secuencias.
    const quoted = targets.map((table) => `"${table}"`).join(", ");
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`,
    );

    const usersAfter = await prisma.user.count();

    // Red de seguridad en caliente: si por lo que sea la cuenta de usuarios
    // cambió, algo salió muy mal. Se avisa fuerte.
    if (usersAfter !== usersBefore) {
      throw new Error(
        `Los usuarios cambiaron durante el blanqueo (${usersBefore} -> ${usersAfter}). ` +
          "Esto NO debería pasar; revisá la base.",
      );
    }

    console.log(
      `Blanqueo OK. Tablas borradas: ${targets.length}. ` +
        `Usuarios conservados: ${usersAfter}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("Blanqueo falló:", error);
  process.exitCode = 1;
});

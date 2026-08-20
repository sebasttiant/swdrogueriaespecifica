// Ejecutable del seed de arranque: abre la conexión, delega y cierra.
//
// La lógica vive en `seed-bootstrap.ts` para que se pueda probar sin una base.
// Este archivo se ejecuta en cada despliegue (`deploy.sh`, entre las
// migraciones y el arranque de la web), así que se mantiene deliberadamente
// mínimo: todo lo que decida algo va del otro lado.
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../lib/generated/prisma/client";
import { runSeed } from "./seed-bootstrap";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" });
const prisma = new PrismaClient({ adapter });
const email = process.env.SEED_ADMIN_EMAIL ?? "admin@ilasesorias.com";

runSeed(prisma, { email, password: process.env.SEED_ADMIN_PASSWORD ?? "" })
  .then((existed) => {
    console.log(`Seed OK. Admin: ${email} (${existed ? "ya existía" : "creado"})`);
  })
  .catch((error: unknown) => {
    console.error("Seed falló:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

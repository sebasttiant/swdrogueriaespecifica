import "dotenv/config";
import { defineConfig } from "prisma/config";

// Configuración de Prisma 7 (la URL ya no va en el schema).
//
// `prisma generate` NO necesita conexión; solo Migrate/seed la usan. Por eso
// el `datasource.url` se declara únicamente cuando `DATABASE_URL` está presente:
// así `generate` (postinstall, build, Docker) funciona sin secretos, y Migrate
// recibe la URL real en runtime (inyectada por docker-compose o `.env`).
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx ./prisma/seed.ts",
  },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});

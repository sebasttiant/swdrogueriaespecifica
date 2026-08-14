import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// --------------------------------------------------------------------------
// Gate de PostgreSQL: suite APARTE de `pnpm test`.
//
// Estos tests corren contra un PostgreSQL real y descartable (ver
// `tests/postgres/setup.ts`). La suite por defecto no abre ninguna conexión:
// por eso los archivos de acá llevan el sufijo `.pg.test.ts` y `vitest.config`
// los excluye.
//
// Se corre con `pnpm test:pg:operational` y necesita `TEST_DATABASE_URL`.
// --------------------------------------------------------------------------

export default defineConfig({
  // Mismo alias `@/*` -> raíz de apps/web que la configuración base.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Explícito: un `.only` olvidado dejaría el gate verde sin probar nada.
    allowOnly: false,
    include: ["tests/postgres/**/*.pg.test.ts"],
    exclude: ["node_modules", ".next", "lib/generated"],
    // Crea la base descartable, aplica migraciones y garantiza el borrado.
    globalSetup: ["./tests/postgres/setup.ts"],
    // Cada worker apunta su DATABASE_URL a esa base antes de cargar nada.
    setupFiles: ["./tests/postgres/use-disposable-database.ts"],
    // Una sola base por corrida: dos archivos en paralelo se pisarían los datos.
    fileParallelism: false,
    // Crear la base y aplicar todas las migraciones lleva su tiempo en CI.
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});

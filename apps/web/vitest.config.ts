import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resuelve el alias `@/*` -> raíz de apps/web, igual que tsconfig `paths`.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    allowOnly: false,
    include: ["**/*.test.ts"],
    // Los `*.pg.test.ts` corren contra un PostgreSQL real y viven en su propia
    // configuración (`vitest.postgres.config.ts`): esta suite no toca la base.
    exclude: ["node_modules", ".next", "lib/generated", "**/*.pg.test.ts"],
  },
});

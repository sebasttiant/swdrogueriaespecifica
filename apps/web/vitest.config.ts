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
    exclude: ["node_modules", ".next", "lib/generated"],
  },
});

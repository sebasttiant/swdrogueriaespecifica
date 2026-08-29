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
    // Los archivos de interacción (jsdom + `userEvent`) tardan cientos de
    // milisegundos por gesto, y corren en paralelo con el resto. Con el default
    // de 5 s, sumar archivos a la suite les robaba tiempo de CPU hasta hacerlos
    // fallar por INANICIÓN: un `Test timed out` o un "se esperaba 1 llamada y
    // hubo 0" que no denuncian ningún defecto del código, solo una máquina
    // ocupada. Un test que falla según cuántos vecinos tenga no informa nada.
    //
    // No debilita ninguna aserción: son los MISMOS chequeos con más aire. Y
    // sigue siendo un tope corto, así que un cuelgue real se delata igual.
    testTimeout: 15_000,
    include: ["**/*.test.ts"],
    // Los `*.pg.test.ts` corren contra un PostgreSQL real y viven en su propia
    // configuración (`vitest.postgres.config.ts`): esta suite no toca la base.
    exclude: ["node_modules", ".next", "lib/generated", "**/*.pg.test.ts"],
  },
});

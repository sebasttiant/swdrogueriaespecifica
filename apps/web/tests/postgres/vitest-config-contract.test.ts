import { describe, expect, it } from "vitest";

import baseConfig from "../../vitest.config";
import postgresConfig from "../../vitest.postgres.config";

// El harness de PostgreSQL es una suite APARTE: `pnpm test` no puede abrir
// conexiones a ninguna base. Este test fija ese contrato entre las dos
// configuraciones para que no se rompa sin que nadie se entere.

const PG_SUFFIX = "*.pg.test.ts";

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

describe("vitest.postgres.config", () => {
  it("declara allowOnly:false de forma explícita", () => {
    expect(postgresConfig.test?.allowOnly).toBe(false);
  });

  it("solo levanta los tests del harness de PostgreSQL", () => {
    const include = asArray(postgresConfig.test?.include);

    expect(include.length).toBeGreaterThan(0);
    for (const pattern of include) {
      expect(pattern).toContain("tests/postgres/");
      expect(pattern.endsWith(PG_SUFFIX)).toBe(true);
    }
  });

  it("engancha el ciclo de vida de la base descartable", () => {
    const globalSetup = asArray(
      postgresConfig.test?.globalSetup as string | string[] | undefined,
    );

    expect(globalSetup.some((entry) => entry.includes("tests/postgres/setup"))).toBe(
      true,
    );
  });

  // Sin esto, el código de la aplicación seguiría leyendo la DATABASE_URL del
  // entorno en lugar de la base descartable.
  it("apunta DATABASE_URL a la base descartable en cada worker", () => {
    const setupFiles = asArray(postgresConfig.test?.setupFiles);

    expect(
      setupFiles.some((entry) => entry.includes("tests/postgres/use-disposable-database")),
    ).toBe(true);
  });

  // Una sola base descartable por corrida: dos archivos en paralelo se pisarían
  // los datos y volverían inútil cualquier prueba de concurrencia.
  it("corre los archivos en serie", () => {
    expect(postgresConfig.test?.fileParallelism).toBe(false);
  });

  it("resuelve el alias `@` igual que la configuración base", () => {
    expect(postgresConfig.resolve?.alias).toHaveProperty("@");
  });
});

describe("vitest.config", () => {
  // Invariante: la suite por defecto NUNCA toca PostgreSQL.
  it("excluye los tests del harness de PostgreSQL", () => {
    const exclude = asArray(baseConfig.test?.exclude);

    expect(exclude.some((pattern) => pattern.endsWith(PG_SUFFIX))).toBe(true);
  });

  it("mantiene allowOnly:false", () => {
    expect(baseConfig.test?.allowOnly).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  assertDisposableBaseUrl,
  assertDisposableDatabaseName,
  buildDisposableDatabaseUrl,
  createDisposableDatabaseName,
  DISPOSABLE_DATABASE_PREFIX,
  quoteIdentifier,
} from "./database-identity-guard";

const APP_URL = "postgresql://drogueria:secret@db.interno:5432/drogueria?schema=public";
const MAINTENANCE_URL = "postgresql://postgres:secret@localhost:55432/postgres";

describe("assertDisposableBaseUrl", () => {
  it("accepts a maintenance database on a throwaway cluster", () => {
    expect(() =>
      assertDisposableBaseUrl(MAINTENANCE_URL, { nodeEnv: "test" }),
    ).not.toThrow();
  });

  it("accepts a base url that already points at a disposable database", () => {
    expect(() =>
      assertDisposableBaseUrl(
        `postgresql://postgres:secret@localhost:55432/${DISPOSABLE_DATABASE_PREFIX}abc`,
        { nodeEnv: "test" },
      ),
    ).not.toThrow();
  });

  // Invariante de seguridad: sin URL explícita no se adivina nada. El harness
  // JAMÁS cae por defecto a la base de la aplicación.
  it("rejects a missing or blank url", () => {
    expect(() => assertDisposableBaseUrl(undefined, { nodeEnv: "test" })).toThrow(
      /TEST_DATABASE_URL/,
    );
    expect(() => assertDisposableBaseUrl("   ", { nodeEnv: "test" })).toThrow(
      /TEST_DATABASE_URL/,
    );
  });

  it("rejects a url that is not postgres", () => {
    expect(() =>
      assertDisposableBaseUrl("mysql://root@localhost:3306/postgres", {
        nodeEnv: "test",
      }),
    ).toThrow(/postgres/i);
  });

  it("rejects anything that is not a valid url", () => {
    expect(() =>
      assertDisposableBaseUrl("no-es-una-url", { nodeEnv: "test" }),
    ).toThrow();
  });

  // Invariante de seguridad: una base operativa NUNCA es material de pruebas,
  // aunque alguien la pase a mano.
  it("rejects a real application database name", () => {
    expect(() =>
      assertDisposableBaseUrl("postgresql://drogueria:secret@localhost:5432/drogueria", {
        nodeEnv: "test",
      }),
    ).toThrow(/descartable/i);
  });

  // Invariante de seguridad: mismo destino que la app = producción potencial.
  it("rejects the same host, port and database as the application", () => {
    expect(() =>
      assertDisposableBaseUrl(APP_URL, {
        nodeEnv: "test",
        appDatabaseUrl: APP_URL,
      }),
    ).toThrow(/aplicación/i);
  });

  it("rejects the application target even when the credentials differ", () => {
    expect(() =>
      assertDisposableBaseUrl("postgresql://otro:otra@db.interno:5432/postgres", {
        nodeEnv: "test",
        appDatabaseUrl: "postgresql://drogueria:secret@db.interno:5432/postgres",
      }),
    ).toThrow(/aplicación/i);
  });

  it("allows the same cluster when the database differs from the application one", () => {
    expect(() =>
      assertDisposableBaseUrl("postgresql://drogueria:secret@db.interno:5432/postgres", {
        nodeEnv: "test",
        appDatabaseUrl: APP_URL,
      }),
    ).not.toThrow();
  });

  // Invariante de seguridad: el harness no existe en producción.
  it("rejects running under NODE_ENV=production", () => {
    expect(() =>
      assertDisposableBaseUrl(MAINTENANCE_URL, { nodeEnv: "production" }),
    ).toThrow(/producción/i);
  });

  it("ignores an unparseable application url instead of failing open", () => {
    expect(() =>
      assertDisposableBaseUrl(MAINTENANCE_URL, {
        nodeEnv: "test",
        appDatabaseUrl: "no-es-una-url",
      }),
    ).not.toThrow();
  });
});

describe("createDisposableDatabaseName", () => {
  it("always carries the disposable prefix", () => {
    expect(createDisposableDatabaseName("a1b2c3")).toBe(
      `${DISPOSABLE_DATABASE_PREFIX}a1b2c3`,
    );
  });

  it("normalizes anything that is not a safe identifier character", () => {
    expect(createDisposableDatabaseName("2026-08-14T10:00Z/ABC")).toBe(
      `${DISPOSABLE_DATABASE_PREFIX}2026_08_14t10_00z_abc`,
    );
  });

  // Postgres trunca los identificadores a 63 bytes: si el nombre creado no
  // fuera el mismo que el borrado, el teardown dejaría bases huérfanas.
  it("stays inside the postgres identifier limit", () => {
    const name = createDisposableDatabaseName("x".repeat(200));
    expect(name.length).toBe(63);
    expect(name.startsWith(DISPOSABLE_DATABASE_PREFIX)).toBe(true);
  });

  it("rejects a suffix with no usable characters", () => {
    expect(() => createDisposableDatabaseName("///")).toThrow();
  });
});

describe("assertDisposableDatabaseName", () => {
  it("accepts a generated name", () => {
    expect(() =>
      assertDisposableDatabaseName(createDisposableDatabaseName("smoke")),
    ).not.toThrow();
  });

  // Invariante de seguridad: este es el último filtro antes de un DROP DATABASE.
  it("rejects any name without the disposable prefix", () => {
    for (const name of ["drogueria", "postgres", "template1", "", "test_drogueria"]) {
      expect(() => assertDisposableDatabaseName(name)).toThrow();
    }
  });

  it("rejects a name with characters outside the safe identifier set", () => {
    expect(() =>
      assertDisposableDatabaseName(`${DISPOSABLE_DATABASE_PREFIX}a"; DROP DATABASE x`),
    ).toThrow();
  });

  it("rejects a name longer than the postgres identifier limit", () => {
    expect(() =>
      assertDisposableDatabaseName(`${DISPOSABLE_DATABASE_PREFIX}${"a".repeat(64)}`),
    ).toThrow();
  });
});

describe("buildDisposableDatabaseUrl", () => {
  it("swaps the database keeping host, credentials and parameters", () => {
    const url = buildDisposableDatabaseUrl(
      "postgresql://postgres:secret@localhost:55432/postgres?schema=public&connect_timeout=5",
      `${DISPOSABLE_DATABASE_PREFIX}smoke`,
    );

    expect(url).toBe(
      `postgresql://postgres:secret@localhost:55432/${DISPOSABLE_DATABASE_PREFIX}smoke?schema=public&connect_timeout=5`,
    );
  });

  // Invariante de seguridad: no se construye una URL hacia una base que no
  // creamos nosotros.
  it("rejects a database that is not disposable", () => {
    expect(() =>
      buildDisposableDatabaseUrl(MAINTENANCE_URL, "drogueria"),
    ).toThrow();
  });
});

describe("quoteIdentifier", () => {
  it("wraps the identifier in double quotes", () => {
    expect(quoteIdentifier(`${DISPOSABLE_DATABASE_PREFIX}smoke`)).toBe(
      `"${DISPOSABLE_DATABASE_PREFIX}smoke"`,
    );
  });

  it("rejects an identifier that is not disposable", () => {
    expect(() => quoteIdentifier('drogueria"; DROP DATABASE x')).toThrow();
  });
});

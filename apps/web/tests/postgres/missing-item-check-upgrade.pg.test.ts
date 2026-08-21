// --------------------------------------------------------------------------
// La MIGRACIÓN del CHECK de `receivedQuantity`, probada como migración.
//
// `manual-missing-item-receipt.pg.test.ts` prueba el COMPORTAMIENTO que la
// migración habilita. Esto prueba otra cosa: que el salto de esquema en sí
// sea seguro sobre una base que ya tiene datos viejos. Son preguntas
// distintas y ninguna cubre a la otra.
//
// POR QUÉ LEVANTA SU PROPIO CONTENEDOR, contra la convención del resto de
// `tests/postgres/`: el harness entrega una base con TODAS las migraciones ya
// aplicadas, y acá hace falta justo lo contrario —el esquema ANTERIOR, con
// filas dentro, para recién entonces aplicar la migración y ver qué pasa con
// lo que ya estaba—. Eso no se puede pedir sobre la base del harness sin
// deshacerle el estado a los demás archivos.
//
// Rescatado de `feature/controlled-pendings-recovery-c1-d11`, que quedó fuera
// de main cuando la migración se subió renumerada en el PR #150. Vivía en
// `server/recovery/`, donde NINGUNA de las dos suites lo levantaba: el sufijo
// `.pg.test.ts` lo saca de `pnpm test` y `vitest.postgres.config.ts` solo
// incluye `tests/postgres/**`. Estuvo escrito y sin correr nunca.
// --------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(
    process.cwd(),
    "prisma/migrations/20260819170000_widen_missing_item_received_quantity_check/migration.sql",
  ),
  "utf8",
);
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const containerName = `check-upgrade-${suffix}`;
const postgresUser = "check_upgrade";
const postgresPassword = randomUUID();

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Se conecta por TCP a 127.0.0.1 y NO por el socket de Unix, y esa diferencia
// es la que decide si el chequeo de "ya está listo" dice la verdad.
//
// La imagen de postgres arranca PRIMERO un servidor temporal para correr initdb
// —con `listen_addresses` vacío, o sea socket y nada de TCP—, lo usa, y después
// LO APAGA para levantar el definitivo. Un `SELECT 1` por el socket responde
// contra ese servidor temporal: el bucle de espera se da por satisfecho, los
// tests arrancan, e initdb apaga el servidor debajo de ellos.
//
// De ahí salía `FATAL: the database system is shutting down` en CI, seguido del
// socket desaparecido. Por TCP no pasa: el temporal no escucha ahí, así que la
// espera solo termina cuando el servidor real está arriba.
function psql(sql: string): string {
  return docker([
    "exec",
    "-e",
    `PGPASSWORD=${postgresPassword}`,
    containerName,
    "psql",
    "-h",
    "127.0.0.1",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    postgresUser,
    "-d",
    "postgres",
    "-At",
    "-c",
    sql,
  ]);
}

function runMigration(): void {
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      `PGPASSWORD=${postgresPassword}`,
      containerName,
      "psql",
      "-h",
      "127.0.0.1",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      postgresUser,
      "-d",
      "postgres",
    ],
    { input: migrationSql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
}

function createSchema(receivedBound: string): void {
  psql(`
    CREATE TABLE missing_items (
      id text PRIMARY KEY,
      quantity integer NOT NULL,
      "orderedQuantity" integer,
      "receivedQuantity" integer NOT NULL DEFAULT 0,
      CONSTRAINT "missing_items_receivedQuantity_check" CHECK (${receivedBound})
    );
    CREATE TABLE inventory_entries (id text PRIMARY KEY, quantity integer NOT NULL);
    CREATE TABLE product_batches (id text PRIMARY KEY, quantity integer NOT NULL);
  `);
}

function createPreUpgradeSchema(): void {
  createSchema(`"receivedQuantity" >= 0 AND "receivedQuantity" <= quantity`);
}

function createPostUpgradeSchema(): void {
  createSchema(
    `"receivedQuantity" >= 0 AND "receivedQuantity" <= GREATEST(quantity, COALESCE("orderedQuantity", quantity))`,
  );
}

describe("widen_missing_item_received_quantity_check migration", () => {
  beforeAll(() => {
    docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--label",
      "ai.gentle.task=missing-item-check-upgrade",
      "--label",
      "ai.gentle.disposable=true",
      "--network",
      "none",
      "-e",
      `POSTGRES_USER=${postgresUser}`,
      "-e",
      `POSTGRES_PASSWORD=${postgresPassword}`,
      "postgres:18-alpine",
    ]);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        psql("SELECT 1");
        return;
      } catch {
        execFileSync("sleep", ["1"]);
      }
    }
    throw new Error("Disposable PostgreSQL container did not become ready");
  }, 45_000);

  beforeEach(() => {
    psql("DROP TABLE IF EXISTS inventory_entries, product_batches, missing_items CASCADE;");
  });

  afterAll(() => {
    execFileSync("docker", ["rm", "--force", "--volumes", containerName], { stdio: "ignore" });
  });

  it("admits the widened contract on a fresh deployment", () => {
    createPostUpgradeSchema();
    psql(`INSERT INTO missing_items VALUES ('fresh-native', 1, 20, 5);`);
    psql(`INSERT INTO missing_items VALUES ('fresh-legacy', 10, 3, 7);`);

    expect(psql(`SELECT id || ':' || "receivedQuantity" FROM missing_items ORDER BY id;`))
      .toBe("fresh-legacy:7\nfresh-native:5\n");
    expect(() => psql(`UPDATE missing_items SET "receivedQuantity" = 21 WHERE id = 'fresh-native';`)).toThrow();
  });

  it("upgrades the old constraint without rewriting legacy rows", () => {
    createPreUpgradeSchema();
    psql(`INSERT INTO missing_items VALUES ('native', 1, 20, 0), ('legacy', 10, 3, 7);`);
    expect(() => psql(`UPDATE missing_items SET "receivedQuantity" = 5 WHERE id = 'native';`)).toThrow();

    runMigration();
    psql(`UPDATE missing_items SET "receivedQuantity" = 5 WHERE id = 'native';`);

    expect(psql(`SELECT quantity || '/' || "orderedQuantity" || '/' || "receivedQuantity" FROM missing_items ORDER BY id;`))
      .toBe("10/3/7\n1/20/5\n");
  });

  it("rejects an invalid entry transaction atomically after the upgrade", () => {
    createPreUpgradeSchema();
    psql(`INSERT INTO missing_items VALUES ('atomic', 1, 20, 0);`);
    runMigration();

    expect(() => psql(`
      BEGIN;
      INSERT INTO inventory_entries VALUES ('entry-rollback', 5);
      INSERT INTO product_batches VALUES ('batch-rollback', 5);
      UPDATE missing_items SET "receivedQuantity" = 21 WHERE id = 'atomic';
      COMMIT;
    `)).toThrow();
    expect(psql(`SELECT "receivedQuantity" FROM missing_items WHERE id = 'atomic';`)).toBe("0\n");
    expect(psql(`SELECT count(*) FROM inventory_entries UNION ALL SELECT count(*) FROM product_batches;`))
      .toBe("0\n0\n");
  });

  it("commits a valid SQL entry transaction after the upgrade", () => {
    createPreUpgradeSchema();
    psql(`INSERT INTO missing_items VALUES ('valid', 1, 20, 0);`);
    runMigration();
    psql(`
      BEGIN;
      UPDATE missing_items SET "receivedQuantity" = 5 WHERE id = 'valid';
      INSERT INTO inventory_entries VALUES ('entry-commit', 5);
      INSERT INTO product_batches VALUES ('batch-commit', 5);
      COMMIT;
    `);

    expect(psql(`SELECT "receivedQuantity" FROM missing_items WHERE id = 'valid';`)).toBe("5\n");
    expect(psql(`SELECT count(*) FROM inventory_entries UNION ALL SELECT count(*) FROM product_batches;`))
      .toBe("1\n1\n");
  });
});

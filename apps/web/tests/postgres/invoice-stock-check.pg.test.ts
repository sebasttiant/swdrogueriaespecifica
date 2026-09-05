// --------------------------------------------------------------------------
// La MIGRACIÓN que repone el CHECK de stock al facturar, probada como migración.
//
// La pregunta que responde no es "¿la regla funciona?" —eso lo prueban los
// tests de `invoicePending`— sino "¿este salto de esquema es seguro sobre la
// base que YA existe?". Producción tiene 22 filas anteriores a la regla con
// `invoicedQuantity > inventoryReadyQuantity`, y una migración que las tropiece
// deja el despliegue a mitad de camino.
//
// Reproduce esa situación exacta: filas terminales que violan la regla vieja,
// filas abiertas que la cumplen, y recién entonces aplica la migración.
//
// Levanta su propio contenedor por el mismo motivo que
// `missing-item-check-upgrade.pg.test.ts`: el harness compartido entrega la base
// con TODAS las migraciones aplicadas, y acá hace falta el esquema ANTERIOR con
// datos adentro.
// --------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(
    process.cwd(),
    "prisma/migrations/20260904120000_restore_invoice_stock_check/migration.sql",
  ),
  "utf8",
);
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const containerName = `invoice-stock-check-${suffix}`;
const postgresUser = "invoice_stock";
const postgresPassword = randomUUID();

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Por TCP y no por el socket de Unix: ver la nota extensa en
// `missing-item-check-upgrade.pg.test.ts`. El servidor temporal de initdb
// responde por socket y haría que la espera termine antes de tiempo.
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

// El esquema TAL COMO ESTÁ HOY en producción: el CHECK que dejó
// `20260731010000_invoice_before_arrival`, sin la comprobación de stock.
function createPreMigrationSchema(): void {
  psql(`
    CREATE TYPE "PendingStatus" AS ENUM (
      'PENDIENTE', 'PARCIAL', 'ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL'
    );
    CREATE TABLE pendings (
      id text PRIMARY KEY,
      status "PendingStatus" NOT NULL,
      quantity integer NOT NULL,
      "inventoryReadyQuantity" integer NOT NULL DEFAULT 0,
      "reservedInventoryQuantity" integer NOT NULL DEFAULT 0,
      "invoicedQuantity" integer NOT NULL DEFAULT 0,
      "deliveredQuantity" integer NOT NULL DEFAULT 0,
      CONSTRAINT "pendings_quantities_check" CHECK (
        "inventoryReadyQuantity" >= 0
        AND "inventoryReadyQuantity" <= "quantity"
        AND "reservedInventoryQuantity" >= 0
        AND "reservedInventoryQuantity" <= "inventoryReadyQuantity"
        AND "invoicedQuantity" >= 0
        AND "invoicedQuantity" <= "quantity"
        AND "deliveredQuantity" >= 0
        AND "deliveredQuantity" <= "invoicedQuantity"
      )
    );
  `);
}

// Las filas que ya existen en producción: ventas reales hechas bajo la regla
// vieja, todas cerradas. 18 entregadas y 4 canceladas al 2026-09-04.
function seedLegacyTerminalRows(): void {
  psql(`
    INSERT INTO pendings (id, status, quantity, "inventoryReadyQuantity", "invoicedQuantity", "deliveredQuantity") VALUES
      ('legacy-entregado', 'ENTREGADO', 10, 0, 10, 10),
      ('legacy-cancelado', 'CANCELADO', 5, 1, 5, 0),
      ('legacy-parcial',   'CLOSED_PARTIAL', 8, 2, 6, 6);
  `);
}

describe("restore_invoice_stock_check migration", () => {
  beforeAll(() => {
    docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--label",
      "ai.gentle.task=invoice-stock-check",
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
    psql(`DROP TABLE IF EXISTS pendings CASCADE; DROP TYPE IF EXISTS "PendingStatus";`);
  });

  afterAll(() => {
    execFileSync("docker", ["rm", "--force", "--volumes", containerName], { stdio: "ignore" });
  });

  // EL caso que decidió el diseño. Sin la guarda de estado, esta migración
  // aborta sobre las 22 filas de producción y el despliegue queda a medias.
  it("aplica sobre las filas terminales que ya violaban la regla, sin reescribirlas", () => {
    createPreMigrationSchema();
    seedLegacyTerminalRows();

    runMigration();

    expect(
      psql(`SELECT id || ':' || "invoicedQuantity" || '/' || "inventoryReadyQuantity" FROM pendings ORDER BY id;`),
    ).toBe("legacy-cancelado:5/1\nlegacy-entregado:10/0\nlegacy-parcial:6/2\n");
  });

  // Un CHECK sin la guarda —incluso NOT VALID— se evalúa en cada UPDATE, así que
  // esas 22 filas quedarían congeladas: cualquier corrección posterior fallaría.
  // Con la guarda siguen siendo operables.
  it("deja las filas terminales viejas actualizables después de migrar", () => {
    createPreMigrationSchema();
    seedLegacyTerminalRows();
    runMigration();

    psql(`UPDATE pendings SET "deliveredQuantity" = 9 WHERE id = 'legacy-entregado';`);

    expect(psql(`SELECT "deliveredQuantity" FROM pendings WHERE id = 'legacy-entregado';`)).toBe("9\n");
  });

  it("impide facturar más de lo que llegó en un pendiente abierto", () => {
    createPreMigrationSchema();
    psql(`
      INSERT INTO pendings (id, status, quantity, "inventoryReadyQuantity", "invoicedQuantity")
      VALUES ('abierto', 'PENDIENTE', 10, 3, 0);
    `);
    runMigration();

    expect(() => psql(`UPDATE pendings SET "invoicedQuantity" = 4 WHERE id = 'abierto';`)).toThrow();
    expect(psql(`SELECT "invoicedQuantity" FROM pendings WHERE id = 'abierto';`)).toBe("0\n");
  });

  it("admite la factura parcial hasta el tope de lo que llegó", () => {
    createPreMigrationSchema();
    psql(`
      INSERT INTO pendings (id, status, quantity, "inventoryReadyQuantity", "invoicedQuantity")
      VALUES ('abierto', 'PENDIENTE', 10, 3, 0);
    `);
    runMigration();

    psql(`UPDATE pendings SET "invoicedQuantity" = 3 WHERE id = 'abierto';`);

    expect(psql(`SELECT "invoicedQuantity" FROM pendings WHERE id = 'abierto';`)).toBe("3\n");
  });

  // Sin stock cargado no entra ni una unidad: es el defecto que reportó gerencia
  // el 2026-10-04, cerrado también a nivel base.
  it("impide facturar un pendiente abierto sin nada cargado", () => {
    createPreMigrationSchema();
    psql(`
      INSERT INTO pendings (id, status, quantity, "inventoryReadyQuantity", "invoicedQuantity")
      VALUES ('sin-stock', 'PENDIENTE', 10, 0, 0);
    `);
    runMigration();

    expect(() => psql(`UPDATE pendings SET "invoicedQuantity" = 1 WHERE id = 'sin-stock';`)).toThrow();
  });

  // La migración FALLA RUIDOSAMENTE si aparece una fila ABIERTA que viola la
  // regla —alguien facturó sin stock con el código viejo todavía corriendo—.
  // Fallar acá es lo correcto: la transacción no se aplica y no rompe nada.
  // Es lo que el preflight documentado en la migración busca detectar antes.
  it("aborta si queda un pendiente ABIERTO violando la regla", () => {
    createPreMigrationSchema();
    psql(`
      INSERT INTO pendings (id, status, quantity, "inventoryReadyQuantity", "invoicedQuantity")
      VALUES ('abierto-sucio', 'PENDIENTE', 10, 0, 4);
    `);

    expect(() => runMigration()).toThrow();
  });
});

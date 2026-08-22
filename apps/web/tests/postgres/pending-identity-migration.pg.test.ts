import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// S2b · 1a: la migración del aplazamiento de identidad, probada SOBRE DATOS QUE
// YA EXISTÍAN. Que sea aditiva no se afirma leyendo el SQL: se demuestra
// creando una fila con el esquema anterior, aplicando la migración encima y
// comprobando que la fila sigue igual, byte por byte.
//
// Contenedor propio y no el harness compartido porque hay que partir de un
// esquema PREVIO a esta migración, que el harness ya trae aplicada.

const migrationSql = readFileSync(
  resolve(process.cwd(), "prisma/migrations/20260821200000_add_pending_identity_deferral/migration.sql"),
  "utf8",
);

const containerName = `s2b-mig-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const user = "s2b_migration";
const password = randomUUID();

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Por TCP y no por el socket: el servidor temporal de initdb responde en el
// socket y después se apaga, así que esperar por ahí da un listo que miente.
function psql(sql: string): string {
  return docker([
    "exec", "-e", `PGPASSWORD=${password}`, containerName,
    "psql", "-h", "127.0.0.1", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", "postgres", "-At", "-c", sql,
  ]);
}

function applyMigration(): void {
  execFileSync(
    "docker",
    ["exec", "-i", "-e", `PGPASSWORD=${password}`, containerName,
     "psql", "-h", "127.0.0.1", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", "postgres"],
    { input: migrationSql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
}

/** El `pendings` de ANTES: solo lo que la migración necesita encontrar. */
function createPreMigrationSchema(): void {
  psql(`
    CREATE TABLE pendings (
      id text PRIMARY KEY,
      "productId" text NOT NULL,
      "createdById" text,
      quantity integer NOT NULL,
      note text
    );
  `);
}

const HISTORICAL = { id: "pend-historico", productId: "prod-1", createdById: "user-1", quantity: 7, note: "cliente pidió dos cajas" };

beforeAll(() => {
  docker([
    "run", "--detach", "--rm", "--name", containerName,
    "--label", "ai.gentle.disposable=true", "--network", "none",
    "-e", `POSTGRES_USER=${user}`, "-e", `POSTGRES_PASSWORD=${password}`,
    "postgres:18-alpine",
  ]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      psql("SELECT 1");
      break;
    } catch {
      execFileSync("sleep", ["1"]);
    }
  }

  createPreMigrationSchema();
  psql(`INSERT INTO pendings VALUES ('${HISTORICAL.id}', '${HISTORICAL.productId}', '${HISTORICAL.createdById}', ${HISTORICAL.quantity}, '${HISTORICAL.note}');`);
  applyMigration();
}, 60_000);

afterAll(() => {
  execFileSync("docker", ["rm", "--force", "--volumes", containerName], { stdio: "ignore" });
});

describe("migración del aplazamiento de identidad", () => {
  it("deja intacta la fila que ya existía", () => {
    const row = psql(`SELECT id, "productId", "createdById", quantity, note FROM pendings WHERE id = '${HISTORICAL.id}';`).trim();

    expect(row).toBe(
      `${HISTORICAL.id}|${HISTORICAL.productId}|${HISTORICAL.createdById}|${HISTORICAL.quantity}|${HISTORICAL.note}`,
    );
  });

  // NULL en la fila vieja significa "no se aplazó", no "se desconoce": la
  // migración no infiere nada sobre ventas que ocurrieron antes de existir.
  it("no inventa un aplazamiento donde no lo hubo", () => {
    const nulls = psql(`SELECT "identitySkippedReason" IS NULL AND "identitySkippedNote" IS NULL FROM pendings WHERE id = '${HISTORICAL.id}';`).trim();

    expect(nulls).toBe("t");
  });

  it("agrega las dos columnas nullable y sin default", () => {
    const cols = psql(`
      SELECT column_name || ':' || is_nullable || ':' || coalesce(column_default, 'none')
      FROM information_schema.columns
      WHERE table_name = 'pendings' AND column_name LIKE 'identitySkipped%'
      ORDER BY column_name;
    `).trim().split("\n");

    expect(cols).toEqual([
      "identitySkippedNote:YES:none",
      "identitySkippedReason:YES:none",
    ]);
  });

  it("declara los cuatro motivos cerrados, en orden", () => {
    const labels = psql(`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'PendingIdentityDeferral' ORDER BY e.enumsortorder;
    `).trim().split("\n");

    expect(labels).toEqual(["ORION_UNAVAILABLE", "CODE_NOT_FOUND", "CODE_ALREADY_ASSIGNED", "OTHER"]);
  });

  // Parciales, y por eso se afirma el WHERE: un índice total crecería con el
  // mostrador entero en vez de con el trabajo que hay por resolver.
  it("crea los dos índices parciales que la cola necesita", () => {
    const defs = psql(`
      SELECT indexname || '|' || indexdef FROM pg_indexes
      WHERE tablename = 'pendings' AND indexdef ILIKE '%identitySkippedReason%'
      ORDER BY indexname;
    `).trim().split("\n");

    expect(defs).toHaveLength(2);
    expect(defs[0]).toContain("createdById");
    expect(defs[1]).toContain("productId");
    for (const d of defs) expect(d).toMatch(/WHERE .*identitySkippedReason.* IS NOT NULL/i);
  });

  it("no agrega ni borra filas", () => {
    expect(psql("SELECT count(*) FROM pendings;").trim()).toBe("1");
  });
});

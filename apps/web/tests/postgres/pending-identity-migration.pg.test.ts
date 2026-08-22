import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";

// S2b · 1a: la migración del aplazamiento, probada SOBRE DATOS QUE YA EXISTÍAN.
// Aditiva no se afirma leyendo el SQL: se demuestra con una fila del esquema
// anterior y el archivo real aplicado encima.
//
// UNA infraestructura: el harness que `globalSetup` ya provisiona. Un segundo
// contenedor daría dos bases para una prueba. El estado pre-migración va en un
// ESQUEMA aparte de esa misma base, donde `pendings` todavía no existe.

const SQL = readFileSync(
  resolve(process.cwd(), "prisma/migrations/20260821200000_add_pending_identity_deferral/migration.sql"),
  "utf8",
);
const PROBE = "s2b_pre_migration";
const ROW = { id: "pend-historico", productId: "prod-1", createdById: "user-1", quantity: 7, note: "dos cajas" };

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${PROBE} CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA ${PROBE}`);

  // El `pendings` de ANTES: solo lo que la migración necesita encontrar.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${PROBE}`);
    await tx.$executeRawUnsafe(`
      CREATE TABLE pendings (
        id text PRIMARY KEY,
        "productId" text NOT NULL,
        "createdById" text,
        quantity integer NOT NULL,
        note text
      )`);
    await tx.$executeRawUnsafe(
      `INSERT INTO pendings VALUES ('${ROW.id}', '${ROW.productId}', '${ROW.createdById}', ${ROW.quantity}, '${ROW.note}')`,
    );
  });

  // Comentarios fuera ANTES de partir: uno contiene un `;`. BEGIN/COMMIT se
  // afirman aparte — `$transaction` ya abrió una y anidar no es válido.
  const statements = SQL.replace(/--[^\n]*/g, "")
    .replace(/\b(BEGIN|COMMIT)\s*;/gi, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${PROBE}`);
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
  });
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${PROBE} CASCADE`);
});

function probe<T>(sql: string): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql);
}

describe("migración del aplazamiento de identidad", () => {
  // Un DDL que falle a mitad dejaría la migración marcada como aplicada.
  it("aplica todo su DDL en una sola transacción", () => {
    expect(SQL).toMatch(/^\s*BEGIN;/m);
    expect(SQL.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("deja intacta la fila que ya existía", async () => {
    const rows = await probe<Record<string, unknown>>(
      `SELECT id, "productId", "createdById", quantity, note FROM ${PROBE}.pendings WHERE id = '${ROW.id}'`,
    );

    expect(rows).toEqual([
      { id: ROW.id, productId: ROW.productId, createdById: ROW.createdById, quantity: ROW.quantity, note: ROW.note },
    ]);
  });

  // NULL significa "no se aplazó", nunca "se desconoce".
  it("no inventa un aplazamiento donde no lo hubo", async () => {
    const rows = await probe<{ virgen: boolean }>(
      `SELECT ("identitySkippedReason" IS NULL AND "identitySkippedNote" IS NULL) AS virgen
       FROM ${PROBE}.pendings WHERE id = '${ROW.id}'`,
    );

    expect(rows[0]?.virgen).toBe(true);
  });

  it("agrega las dos columnas nullable y sin default", async () => {
    const rows = await probe<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = '${PROBE}' AND table_name = 'pendings'
         AND column_name LIKE 'identitySkipped%' ORDER BY column_name`,
    );

    expect(rows).toEqual([
      { column_name: "identitySkippedNote", is_nullable: "YES", column_default: null },
      { column_name: "identitySkippedReason", is_nullable: "YES", column_default: null },
    ]);
  });

  it("declara los cuatro motivos cerrados, en orden", async () => {
    const rows = await probe<{ enumlabel: string }>(
      `SELECT e.enumlabel FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = '${PROBE}' AND t.typname = 'PendingIdentityDeferral'
       ORDER BY e.enumsortorder`,
    );

    expect(rows.map((r) => r.enumlabel)).toEqual([
      "ORION_UNAVAILABLE",
      "CODE_NOT_FOUND",
      "CODE_ALREADY_ASSIGNED",
      "OTHER",
    ]);
  });

  // Nombre, orden y predicado EXACTOS: (createdById, productId) no sirve para
  // agrupar por producto, y el predicado es lo que acota el tamaño del índice.
  it("crea los dos índices parciales exactos que la cola necesita", async () => {
    const rows = await probe<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = '${PROBE}' AND tablename = 'pendings'
         AND indexdef ILIKE '%identitySkippedReason%' ORDER BY indexname`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    const predicate = `WHERE ("identitySkippedReason" IS NOT NULL)`;

    expect(Object.keys(byName)).toEqual([
      "pendings_identity_deferred_creator_product_idx",
      "pendings_identity_deferred_product_idx",
    ]);
    expect(byName.pendings_identity_deferred_creator_product_idx).toContain(`("createdById", "productId") ${predicate}`);
    expect(byName.pendings_identity_deferred_product_idx).toContain(`("productId") ${predicate}`);
  });

  it("no agrega ni borra filas", async () => {
    const rows = await probe<{ n: bigint }>(`SELECT count(*) AS n FROM ${PROBE}.pendings`);

    expect(Number(rows[0]?.n)).toBe(1);
  });
});

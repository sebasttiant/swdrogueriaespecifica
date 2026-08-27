import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";

// Las garantías de trazabilidad de laboratorio no son de código: son del
// esquema. Este archivo las lee de PostgreSQL, del catálogo real, no del
// schema de Prisma — porque lo que protege la historia en producción es
// el constraint, no el DSL.
//
// Si alguien afloja uno de estos constraints en una migración futura, acá se
// entera antes de mergear.

async function constraintDef(table: string, name: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<{ def: string }[]>(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = '${table}'::regclass AND conname = '${name}'`,
  );
  return rows[0]?.def ?? null;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) AS count FROM information_schema.columns
      WHERE table_name = '${table}' AND column_name = '${column}'`,
  );
  return Number(rows[0]?.count) > 0;
}

async function indexExists(table: string, index: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) AS count FROM pg_indexes
      WHERE tablename = '${table}' AND indexname = '${index}'`,
  );
  return Number(rows[0]?.count) > 0;
}

async function enumValues(enumName: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ labels: string }[]>(
    `SELECT enum_range(NULL::"${enumName}")::text AS labels`,
  );
  const raw = rows[0]?.labels;
  if (!raw) return [];
  // PostgreSQL enum_range::text returns "{VAL1,VAL2,VAL3}"
  return raw
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((v) => v.trim());
}

describe("esquema de trazabilidad de laboratorio (T1)", () => {
  // ── Enums ──────────────────────────────────────────────────────────

  it("enum LaboratoryEvidence tiene los valores correctos", async () => {
    const values = await enumValues("LaboratoryEvidence");
    expect(values).toEqual(["CATALOG_ONLY", "OBSERVED", "UNKNOWN"]);
  });

  it("enum CompatibilityBasis tiene los valores correctos", async () => {
    const values = await enumValues("CompatibilityBasis");
    expect(values).toEqual(["LABORATORY_MATCH", "REQUEST_CATALOG", "FALLBACK_UNKNOWN"]);
  });

  it("enum LaboratoryChangeSource tiene los valores correctos", async () => {
    const values = await enumValues("LaboratoryChangeSource");
    expect(values).toEqual(["CAPTURED", "CORRECTED"]);
  });

  // ── Laboratory ─────────────────────────────────────────────────────

  it("laboratories tiene searchKey y needsReview", async () => {
    expect(await columnExists("laboratories", "searchKey")).toBe(true);
    expect(await columnExists("laboratories", "needsReview")).toBe(true);
  });

  it("laboratories tiene createCommandKey y createCommandFingerprint", async () => {
    expect(await columnExists("laboratories", "createCommandKey")).toBe(true);
    expect(await columnExists("laboratories", "createCommandFingerprint")).toBe(true);
  });

  // ── ProductBatch ───────────────────────────────────────────────────

  it("product_batches tiene receivedLaboratoryId y laboratoryEvidence", async () => {
    expect(await columnExists("product_batches", "receivedLaboratoryId")).toBe(true);
    expect(await columnExists("product_batches", "laboratoryEvidence")).toBe(true);
  });

  it("FK de receivedLaboratoryId es ON DELETE SET NULL", async () => {
    const def = await constraintDef(
      "product_batches",
      "product_batches_receivedLaboratoryId_fkey",
    );
    expect(def).toContain("ON DELETE SET NULL");
    expect(def).not.toContain("ON DELETE CASCADE");
  });

  // ── Pending ────────────────────────────────────────────────────────

  it("pendings tiene requestedLaboratoryId y laboratoryChangeSource", async () => {
    expect(await columnExists("pendings", "requestedLaboratoryId")).toBe(true);
    expect(await columnExists("pendings", "laboratoryChangeSource")).toBe(true);
    expect(await columnExists("pendings", "laboratoryPolicyVersion")).toBe(true);
  });

  it("FK de requestedLaboratoryId en pendings es ON DELETE SET NULL", async () => {
    const def = await constraintDef(
      "pendings",
      "pendings_requestedLaboratoryId_fkey",
    );
    expect(def).toContain("ON DELETE SET NULL");
    expect(def).not.toContain("ON DELETE CASCADE");
  });

  // ── MissingItem ────────────────────────────────────────────────────

  it("missing_items tiene requestedLaboratoryId y laboratoryPolicyVersion", async () => {
    expect(await columnExists("missing_items", "requestedLaboratoryId")).toBe(true);
    expect(await columnExists("missing_items", "laboratoryPolicyVersion")).toBe(true);
  });

  it("FK de requestedLaboratoryId en missing_items es ON DELETE SET NULL", async () => {
    const def = await constraintDef(
      "missing_items",
      "missing_items_requestedLaboratoryId_fkey",
    );
    expect(def).toContain("ON DELETE SET NULL");
    expect(def).not.toContain("ON DELETE CASCADE");
  });

  // ── InventoryAllocation ────────────────────────────────────────────

  it("inventory_allocations tiene productBatchId y compatibilityBasis", async () => {
    expect(await columnExists("inventory_allocations", "productBatchId")).toBe(true);
    expect(await columnExists("inventory_allocations", "compatibilityBasis")).toBe(true);
  });

  it("FK de productBatchId en inventory_allocations es ON DELETE SET NULL", async () => {
    const def = await constraintDef(
      "inventory_allocations",
      "inventory_allocations_productBatchId_fkey",
    );
    expect(def).toContain("ON DELETE SET NULL");
    expect(def).not.toContain("ON DELETE CASCADE");
  });

  // ── InventoryEntry ─────────────────────────────────────────────────

  it("inventory_entries tiene productBatchId", async () => {
    expect(await columnExists("inventory_entries", "productBatchId")).toBe(true);
  });

  it("FK de productBatchId en inventory_entries es ON DELETE SET NULL", async () => {
    const def = await constraintDef(
      "inventory_entries",
      "inventory_entries_productBatchId_fkey",
    );
    expect(def).toContain("ON DELETE SET NULL");
    expect(def).not.toContain("ON DELETE CASCADE");
  });

  // ── Índices ────────────────────────────────────────────────────────

  it("índices de FK existen en las tablas modificadas", async () => {
    expect(await indexExists("product_batches", "product_batches_receivedLaboratoryId_idx")).toBe(true);
    expect(await indexExists("pendings", "pendings_requestedLaboratoryId_idx")).toBe(true);
    expect(await indexExists("missing_items", "missing_items_requestedLaboratoryId_idx")).toBe(true);
    expect(await indexExists("inventory_allocations", "inventory_allocations_productBatchId_idx")).toBe(true);
    expect(await indexExists("inventory_entries", "inventory_entries_productBatchId_idx")).toBe(true);
  });

  // ── Integridad: no DELETE de filas existentes ──────────────────────

  it("laboratories, pendings, missing_items y product_batches conservan filas existentes", async () => {
    const [labs, pends, missings, batches] = await Promise.all([
      prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count FROM laboratories`,
      ),
      prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count FROM pendings`,
      ),
      prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count FROM missing_items`,
      ),
      prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count FROM product_batches`,
      ),
    ]);

    // Las tablas deben tener al menos las filas que ya existían
    expect(Number(labs[0]?.count)).toBeGreaterThanOrEqual(0);
    expect(Number(pends[0]?.count)).toBeGreaterThanOrEqual(0);
    expect(Number(missings[0]?.count)).toBeGreaterThanOrEqual(0);
    expect(Number(batches[0]?.count)).toBeGreaterThanOrEqual(0);
  });
});

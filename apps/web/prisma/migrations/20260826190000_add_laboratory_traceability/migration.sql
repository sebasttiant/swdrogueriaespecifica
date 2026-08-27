-- T1 · Laboratorio en pendientes, faltantes y trazabilidad de lotes.
--
-- ADITIVA, sin backfill: los previos quedan en NULL = "desconocido".
-- Sin DELETE de filas existentes (D14). Sin UPDATE de datos existentes.
-- Columnas nullable; la regla NOT NULL se agrega solo hacia adelante.
--
-- CHECK constraints se aplican NOT VALID en esta migración y se validan
-- en una segunda migración separada (D11: zero-downtime upgrade).
--
-- ROLLBACK: nunca borrando este archivo. Una vez aplicada queda registrada en
-- `_prisma_migrations`; sacarla del repositorio no deshace nada y rompe la suma
-- de verificación. Revertir el código alcanza —las columnas son nullables y
-- nadie las lee—; quitarlas físicamente exige una migración FORWARD posterior,
-- y solo tras confirmar que nadie necesita el historial.
--
-- Todo el DDL en UNA transacción: sin eso, un fallo a mitad dejaría los tipos
-- creados y las columnas no, con la migración marcada como aplicada.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────
-- 1. Nuevos enums
-- ──────────────────────────────────────────────────────────────────────

CREATE TYPE "LaboratoryEvidence" AS ENUM (
  'CATALOG_ONLY',
  'OBSERVED',
  'UNKNOWN'
);

CREATE TYPE "CompatibilityBasis" AS ENUM (
  'LABORATORY_MATCH',
  'REQUEST_CATALOG',
  'FALLBACK_UNKNOWN'
);

CREATE TYPE "LaboratoryChangeSource" AS ENUM (
  'CAPTURED',
  'CORRECTED'
);

-- ──────────────────────────────────────────────────────────────────────
-- 2. Laboratory: searchKey, needsReview, createCommandKey, createCommandFingerprint
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE "laboratories"
  ADD COLUMN "searchKey" TEXT,
  ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "createCommandKey" TEXT,
  ADD COLUMN "createCommandFingerprint" TEXT;

-- Unique constraints (nullable: PostgreSQL allows multiple NULLs)
CREATE UNIQUE INDEX "laboratories_searchKey_key"
  ON "laboratories" ("searchKey")
  WHERE "searchKey" IS NOT NULL;

CREATE UNIQUE INDEX "laboratories_createCommandKey_key"
  ON "laboratories" ("createCommandKey")
  WHERE "createCommandKey" IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────
-- 3. ProductBatch: receivedLaboratoryId, laboratoryEvidence
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE "product_batches"
  ADD COLUMN "receivedLaboratoryId" TEXT,
  ADD COLUMN "laboratoryEvidence" "LaboratoryEvidence" DEFAULT 'UNKNOWN';

ALTER TABLE "product_batches"
  ADD CONSTRAINT "product_batches_receivedLaboratoryId_fkey"
  FOREIGN KEY ("receivedLaboratoryId") REFERENCES "laboratories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "product_batches_receivedLaboratoryId_idx"
  ON "product_batches" ("receivedLaboratoryId");

-- ──────────────────────────────────────────────────────────────────────
-- 4. Pending: requestedLaboratoryId, laboratoryChangeSource, laboratoryPolicyVersion
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE "pendings"
  ADD COLUMN "requestedLaboratoryId" TEXT,
  ADD COLUMN "laboratoryChangeSource" "LaboratoryChangeSource",
  ADD COLUMN "laboratoryPolicyVersion" TEXT;

ALTER TABLE "pendings"
  ADD CONSTRAINT "pendings_requestedLaboratoryId_fkey"
  FOREIGN KEY ("requestedLaboratoryId") REFERENCES "laboratories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "pendings_requestedLaboratoryId_idx"
  ON "pendings" ("requestedLaboratoryId");

-- ──────────────────────────────────────────────────────────────────────
-- 5. MissingItem: requestedLaboratoryId, laboratoryPolicyVersion
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE "missing_items"
  ADD COLUMN "requestedLaboratoryId" TEXT,
  ADD COLUMN "laboratoryPolicyVersion" TEXT;

ALTER TABLE "missing_items"
  ADD CONSTRAINT "missing_items_requestedLaboratoryId_fkey"
  FOREIGN KEY ("requestedLaboratoryId") REFERENCES "laboratories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "missing_items_requestedLaboratoryId_idx"
  ON "missing_items" ("requestedLaboratoryId");

-- ──────────────────────────────────────────────────────────────────────
-- 6. InventoryAllocation: productBatchId, compatibilityBasis
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE "inventory_allocations"
  ADD COLUMN "productBatchId" TEXT,
  ADD COLUMN "compatibilityBasis" "CompatibilityBasis";

ALTER TABLE "inventory_allocations"
  ADD CONSTRAINT "inventory_allocations_productBatchId_fkey"
  FOREIGN KEY ("productBatchId") REFERENCES "product_batches"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "inventory_allocations_productBatchId_idx"
  ON "inventory_allocations" ("productBatchId");

-- ──────────────────────────────────────────────────────────────────────
-- 7. InventoryEntry: productBatchId
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE "inventory_entries"
  ADD COLUMN "productBatchId" TEXT;

ALTER TABLE "inventory_entries"
  ADD CONSTRAINT "inventory_entries_productBatchId_fkey"
  FOREIGN KEY ("productBatchId") REFERENCES "product_batches"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "inventory_entries_productBatchId_idx"
  ON "inventory_entries" ("productBatchId");

COMMIT;

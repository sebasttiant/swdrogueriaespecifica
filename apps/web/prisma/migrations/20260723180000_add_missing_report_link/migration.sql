-- Additive: management can link a provisional report to a catalog product,
-- which generates the canonical MissingItem. Existing rows keep status
-- PENDING_REVIEW and NULL links; no row is rewritten.
-- Rollback: DROP the two indexes and columns. The enum value cannot be dropped
-- in Postgres, but an unused value is harmless.

-- AlterEnum
ALTER TYPE "MissingReportStatus" ADD VALUE 'LINKED';

-- AlterTable
ALTER TABLE "missing_reports" ADD COLUMN "linkedProductId" TEXT;
ALTER TABLE "missing_reports" ADD COLUMN "linkedMissingItemId" TEXT;

-- CreateIndex
CREATE INDEX "missing_reports_linkedProductId_idx" ON "missing_reports"("linkedProductId");

-- CreateIndex
CREATE INDEX "missing_reports_linkedMissingItemId_idx" ON "missing_reports"("linkedMissingItemId");

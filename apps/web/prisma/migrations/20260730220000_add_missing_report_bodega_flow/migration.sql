-- Separa llegada física de la carga real de inventario. Aditiva y forward-only.
-- PostgreSQL no permite usar un enum recién agregado dentro de la misma
-- transacción, por eso el ALTER TYPE queda aislado.
ALTER TYPE "MissingItemStatus" ADD VALUE 'EN_BODEGA';
ALTER TYPE "MissingReportStatus" ADD VALUE 'EN_BODEGA';

BEGIN;

ALTER TABLE "products" ADD COLUMN "provisionalNormalizedName" TEXT;
CREATE UNIQUE INDEX "products_provisionalNormalizedName_key"
  ON "products"("provisionalNormalizedName");

ALTER TABLE "missing_items"
  ADD COLUMN "arrivedAt" TIMESTAMP(3),
  ADD COLUMN "arrivedById" TEXT;
ALTER TABLE "missing_items"
  ADD CONSTRAINT "missing_items_arrivedById_fkey"
  FOREIGN KEY ("arrivedById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "missing_items_status_arrivedAt_idx"
  ON "missing_items"("status", "arrivedAt");

ALTER TABLE "missing_reports"
  ADD COLUMN "arrivedAt" TIMESTAMP(3),
  ADD COLUMN "arrivedById" TEXT;
ALTER TABLE "missing_reports"
  ADD CONSTRAINT "missing_reports_arrivedById_fkey"
  FOREIGN KEY ("arrivedById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;

-- Additive confirmation metadata for Faltantes management OK.
ALTER TABLE "missing_items"
  ADD COLUMN "confirmedAt" TIMESTAMP(3),
  ADD COLUMN "confirmedById" TEXT,
  ADD COLUMN "confirmationNote" TEXT;

CREATE INDEX "missing_items_confirmedAt_idx" ON "missing_items"("confirmedAt");
CREATE INDEX "missing_items_status_confirmedAt_idx" ON "missing_items"("status", "confirmedAt");

ALTER TABLE "missing_items"
  ADD CONSTRAINT "missing_items_confirmedById_fkey"
  FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

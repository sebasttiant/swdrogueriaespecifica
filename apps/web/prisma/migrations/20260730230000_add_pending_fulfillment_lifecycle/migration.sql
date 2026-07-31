-- Forward-only fulfillment lifecycle. PostgreSQL enum values are additive;
-- rollback is fix-forward (stop using new values, migrate data, then recreate
-- the enum only in a planned maintenance migration).
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'BODEGA';
CREATE TYPE "PendingPurchaseStatus" AS ENUM ('POR_PEDIR', 'SOLICITADO', 'BUSQUEDA', 'COTIZANDO', 'AGOTADO');
CREATE TYPE "PendingAvailabilityStatus" AS ENUM ('ESPERANDO', 'LLEGO_BODEGA', 'DISPONIBLE_PARCIAL', 'DISPONIBLE_COMPLETO');
CREATE TYPE "PendingCustomerStatus" AS ENUM ('POR_CONTACTAR', 'CONTACTADO', 'FACTURADO', 'ENTREGADO', 'CANCELADO');

ALTER TABLE "pendings"
  ADD COLUMN "purchaseStatus" "PendingPurchaseStatus" NOT NULL DEFAULT 'POR_PEDIR',
  ADD COLUMN "availabilityStatus" "PendingAvailabilityStatus" NOT NULL DEFAULT 'ESPERANDO',
  ADD COLUMN "customerStatus" "PendingCustomerStatus" NOT NULL DEFAULT 'POR_CONTACTAR',
  ADD COLUMN "inventoryReadyQuantity" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reservedInventoryQuantity" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "invoicedQuantity" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "contactedAt" TIMESTAMP(3), ADD COLUMN "contactedById" TEXT,
  ADD COLUMN "invoicedAt" TIMESTAMP(3), ADD COLUMN "invoicedById" TEXT;
-- ON UPDATE CASCADE is Prisma's default for every relation. Declaring it here
-- keeps the database identical to the datamodel: without it every later
-- `prisma migrate dev` reports permanent drift and offers to reset.
ALTER TABLE "pendings" ADD CONSTRAINT "pendings_contactedById_fkey" FOREIGN KEY ("contactedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "pendings" ADD CONSTRAINT "pendings_invoicedById_fkey" FOREIGN KEY ("invoicedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Preserve historical delivery/cancellation facts without inventing contact or invoice.
UPDATE "pendings" SET "customerStatus" = CASE WHEN "status" = 'ENTREGADO' THEN 'ENTREGADO'::"PendingCustomerStatus" WHEN "status" = 'CANCELADO' THEN 'CANCELADO'::"PendingCustomerStatus" ELSE 'POR_CONTACTAR'::"PendingCustomerStatus" END;
-- A historical partial has delivery evidence but no contact/invoice evidence.
-- Preserve only the quantitative lower bound; new availability can be contacted
-- and invoiced incrementally without fabricating actors or timestamps.
UPDATE "pendings" SET "inventoryReadyQuantity" = "deliveredQuantity", "reservedInventoryQuantity" = "deliveredQuantity", "invoicedQuantity" = "deliveredQuantity", "availabilityStatus" = CASE WHEN "deliveredQuantity" = "quantity" OR "status" = 'ENTREGADO' THEN 'DISPONIBLE_COMPLETO'::"PendingAvailabilityStatus" ELSE 'DISPONIBLE_PARCIAL'::"PendingAvailabilityStatus" END WHERE "deliveredQuantity" > 0;
UPDATE "pendings" SET "purchaseStatus" = CASE "status" WHEN 'SOLICITADO' THEN 'SOLICITADO'::"PendingPurchaseStatus" WHEN 'BUSQUEDA' THEN 'BUSQUEDA'::"PendingPurchaseStatus" WHEN 'COTIZANDO' THEN 'COTIZANDO'::"PendingPurchaseStatus" WHEN 'AGOTADO' THEN 'AGOTADO'::"PendingPurchaseStatus" ELSE 'POR_PEDIR'::"PendingPurchaseStatus" END;
ALTER TABLE "missing_items" ADD COLUMN "receivedQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory_entries" ADD COLUMN "idempotencyKey" TEXT;
UPDATE "inventory_entries" SET "idempotencyKey" = 'legacy:' || "id" WHERE "idempotencyKey" IS NULL;
ALTER TABLE "inventory_entries" ALTER COLUMN "idempotencyKey" SET NOT NULL;
ALTER TABLE "inventory_entries" ADD COLUMN "requestFingerprint" TEXT NOT NULL DEFAULT 'legacy';
-- The defaults above exist only to backfill pre-existing rows. The application
-- always supplies both values, so they are dropped again: a database-side
-- default would silently accept a write that forgot its idempotency key.
ALTER TABLE "inventory_entries" ALTER COLUMN "requestFingerprint" DROP DEFAULT;
CREATE UNIQUE INDEX "inventory_entries_idempotencyKey_key" ON "inventory_entries"("idempotencyKey");
CREATE INDEX "inventory_entries_idempotencyKey_requestFingerprint_idx" ON "inventory_entries"("idempotencyKey", "requestFingerprint");
CREATE TABLE "inventory_allocations" (
  "id" TEXT NOT NULL, "inventoryEntryId" TEXT NOT NULL, "missingItemId" TEXT NOT NULL,
  "pendingId" TEXT, "quantity" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_allocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inventory_allocations_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "inventory_allocations_inventoryEntryId_fkey" FOREIGN KEY ("inventoryEntryId") REFERENCES "inventory_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "inventory_allocations_missingItemId_fkey" FOREIGN KEY ("missingItemId") REFERENCES "missing_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "inventory_allocations_pendingId_fkey" FOREIGN KEY ("pendingId") REFERENCES "pendings"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "inventory_allocations_inventoryEntryId_missingItemId_key" UNIQUE ("inventoryEntryId", "missingItemId")
);
CREATE TABLE "pending_inventory_reservations" (
  "id" TEXT NOT NULL, "pendingId" TEXT NOT NULL, "batchId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pending_inventory_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pending_inventory_reservations_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "pending_inventory_reservations_pendingId_fkey" FOREIGN KEY ("pendingId") REFERENCES "pendings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pending_inventory_reservations_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "product_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pending_inventory_reservations_pendingId_batchId_key" UNIQUE ("pendingId", "batchId")
);
CREATE INDEX "pendings_createdById_createdAt_idx" ON "pendings"("createdById", "createdAt");
CREATE INDEX "pendings_availabilityStatus_customerStatus_idx" ON "pendings"("availabilityStatus", "customerStatus");
CREATE INDEX "inventory_allocations_missingItemId_idx" ON "inventory_allocations"("missingItemId");
CREATE INDEX "inventory_allocations_pendingId_idx" ON "inventory_allocations"("pendingId");
CREATE INDEX "pending_inventory_reservations_pendingId_idx" ON "pending_inventory_reservations"("pendingId");
CREATE INDEX "pending_inventory_reservations_batchId_idx" ON "pending_inventory_reservations"("batchId");
ALTER TABLE "pendings" ADD CONSTRAINT "pendings_quantities_check" CHECK ("inventoryReadyQuantity" >= 0 AND "inventoryReadyQuantity" <= "quantity" AND "reservedInventoryQuantity" >= 0 AND "reservedInventoryQuantity" <= "inventoryReadyQuantity" AND "invoicedQuantity" >= 0 AND "invoicedQuantity" <= "inventoryReadyQuantity" AND "deliveredQuantity" >= 0 AND "deliveredQuantity" <= "invoicedQuantity");
ALTER TABLE "missing_items" ADD CONSTRAINT "missing_items_receivedQuantity_check" CHECK ("receivedQuantity" >= 0 AND "receivedQuantity" <= "quantity");

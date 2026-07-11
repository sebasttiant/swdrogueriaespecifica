-- Additive delivery lifecycle for Pending: partial deliveries + cancellation.
-- No existing rows are broken: every new "pendings" column is nullable or
-- defaulted, and "pending_deliveries" is a brand-new table that only
-- references existing rows via foreign keys. No renames, no drops.

-- CreateTable
CREATE TABLE "pending_deliveries" (
    "id" TEXT NOT NULL,
    "pendingId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pending_deliveries_pendingId_idx" ON "pending_deliveries"("pendingId");

ALTER TABLE "pending_deliveries"
  ADD CONSTRAINT "pending_deliveries_pendingId_fkey"
  FOREIGN KEY ("pendingId") REFERENCES "pendings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pending_deliveries"
  ADD CONSTRAINT "pending_deliveries_deliveredById_fkey"
  FOREIGN KEY ("deliveredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: additive delivery/cancellation columns on "pendings".
ALTER TABLE "pendings"
  ADD COLUMN "deliveredQuantity" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledById" TEXT,
  ADD COLUMN "cancelReason" TEXT;

ALTER TABLE "pendings"
  ADD CONSTRAINT "pendings_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

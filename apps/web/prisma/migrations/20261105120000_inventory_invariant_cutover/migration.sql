-- Issue #332: marks the moment the old inventory code stopped writing.
--
-- Before this release, a reception that reserved units for a pending also
-- subtracted them from product_batches.quantity. From this release on the batch
-- is always the physical total. The one-time repair returns the subtracted
-- units, and it must only touch reservations written by the OLD code: a
-- reception after this migration reserves without subtracting, so restoring it
-- would count the same units twice.
--
-- Migrations run before the new web starts, so this timestamp is the cutover.
-- Stored in UTC like every Prisma DateTime column; one row only.
CREATE TABLE "inventory_invariant_cutover" (
  "id" INTEGER NOT NULL,
  "cutoverAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inventory_invariant_cutover_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inventory_invariant_cutover_single_row" CHECK ("id" = 1)
);

INSERT INTO "inventory_invariant_cutover" ("id", "cutoverAt")
VALUES (1, (now() AT TIME ZONE 'UTC'));

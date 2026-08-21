-- Widen `missing_items_receivedQuantity_check` so the database bound on
-- `receivedQuantity` admits every value allocation can produce.
--
-- Resolves the pre-existing defect recorded as design.md D11 / tasks.md Phase 0.
-- The defect shipped on 2026-07-30 with migration `20260730230000` and is live
-- today; it is NOT introduced by the pendings-inventory-allocation change.
--
-- The mismatch:
--   * A manual faltante is created with the placeholder `quantity = 1`
--     (`MANUAL_MISSING_ITEM_QUANTITY`, missing-item.service.ts:97).
--   * Management later sets `orderedQuantity` (up to 100 000); `orderMissingItem`
--     never writes `quantity`.
--   * Allocation books units against
--     `needed = originId IS NULL ? COALESCE(orderedQuantity, quantity) : quantity`
--     (inventory-entry.service.ts:125) and writes `receivedQuantity` from it.
--   * The old CHECK bounded `receivedQuantity <= quantity`.
-- An arrival of 2+ units against such a row therefore violated the CHECK and
-- rolled back the ENTIRE `registerInventoryEntry` transaction — the entry, the
-- batch increment and every missing-item booking in the same call.
--
-- Resolution taken (design.md D11, option A): `needed` is authoritative and
-- `quantity` stays a placeholder for manual rows. No row is rewritten.
--
-- Why `GREATEST(...)` and not the bare `COALESCE(...)` written in D11's option
-- table: `COALESCE("orderedQuantity", "quantity")` is SMALLER than "quantity"
-- whenever a row was ordered below its recorded deficit. For such a row the bare
-- form is TIGHTER than the constraint being replaced, so `ADD CONSTRAINT` would
-- validate existing rows against a narrower bound and could abort this
-- migration. `GREATEST` is never narrower than the old bound, so validation
-- against existing data cannot fail, while still admitting both branches of
-- `needed`. The application, not this constraint, enforces the exact threshold.
--
-- ADDITIVE AND REVERSIBLE: no row is read, rewritten or deleted. Reversal is a
-- straight swap back, valid only while no row exceeds its `quantity`:
--   SELECT count(*) FROM "missing_items" WHERE "receivedQuantity" > "quantity";
--   -- only if that count is 0:
--   ALTER TABLE "missing_items" DROP CONSTRAINT "missing_items_receivedQuantity_check";
--   ALTER TABLE "missing_items" ADD CONSTRAINT "missing_items_receivedQuantity_check"
--     CHECK ("receivedQuantity" >= 0 AND "receivedQuantity" <= "quantity");

-- ATOMIC. The DROP and the ADD are ONE statement pair with a window between
-- them in which `missing_items` carries NO bound on `receivedQuantity` at all.
-- Run unwrapped, a failure of the ADD — a validation error against live data, a
-- `lock_timeout`, a dropped connection — leaves the table permanently
-- unconstrained, with the migration recorded as failed and nothing pointing at
-- the missing CHECK. Wrapping the pair makes the outcome binary: either the new
-- bound is in place, or the old one still is.
--
-- Both statements are transactional DDL, which PostgreSQL fully supports, and
-- three already-deployed migrations in this repository use the same explicit
-- BEGIN/COMMIT (`20260609120000`, `20260730170000`, `20260730220000`), so the
-- shape is proven against this Prisma version, not assumed.
BEGIN;

-- Bound the ACCESS EXCLUSIVE lock request. Without it, a request queued behind
-- an open transaction blocks every subsequent query on `missing_items` for the
-- blocker's lifetime. Re-run the migration if it times out.
--
-- LOCAL, so the setting dies with this transaction instead of leaking into
-- whatever else Prisma runs on the same connection afterwards.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "missing_items" DROP CONSTRAINT "missing_items_receivedQuantity_check";

ALTER TABLE "missing_items" ADD CONSTRAINT "missing_items_receivedQuantity_check"
  CHECK (
    "receivedQuantity" >= 0
    AND "receivedQuantity" <= GREATEST("quantity", COALESCE("orderedQuantity", "quantity"))
  );

COMMIT;

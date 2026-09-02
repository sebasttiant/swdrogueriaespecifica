BEGIN;

CREATE TYPE "InventoryCutoverState" AS ENUM ('PREPARED', 'ACTIVATED', 'LOCKED');

ALTER TABLE "pendings" ADD COLUMN "legacyBeta" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "missing_items" ADD COLUMN "legacyBeta" BOOLEAN NOT NULL DEFAULT false;

UPDATE "pendings" SET "legacyBeta" = true;
UPDATE "missing_items" SET "legacyBeta" = true;

CREATE TABLE "inventory_cutovers" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "state" "InventoryCutoverState" NOT NULL DEFAULT 'PREPARED',
  "cutoverAt" TIMESTAMP(3),
  "activatedById" TEXT,
  "pendingMarkedCount" INTEGER NOT NULL DEFAULT 0,
  "missingItemMarkedCount" INTEGER NOT NULL DEFAULT 0,
  "productBatchPreservedCount" INTEGER NOT NULL DEFAULT 0,
  "inventoryEntryPreservedCount" INTEGER NOT NULL DEFAULT 0,
  "inventoryAllocationPreservedCount" INTEGER NOT NULL DEFAULT 0,
  "pendingReservationPreservedCount" INTEGER NOT NULL DEFAULT 0,
  "migrationVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  CONSTRAINT "inventory_cutovers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inventory_cutovers_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "inventory_cutovers_nonnegative_counts_check" CHECK (
    "pendingMarkedCount" >= 0 AND "missingItemMarkedCount" >= 0 AND
    "productBatchPreservedCount" >= 0 AND "inventoryEntryPreservedCount" >= 0 AND
    "inventoryAllocationPreservedCount" >= 0 AND "pendingReservationPreservedCount" >= 0
  ),
  CONSTRAINT "inventory_cutovers_activatedById_fkey" FOREIGN KEY ("activatedById")
    REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "inventory_cutovers" (
  "pendingMarkedCount", "missingItemMarkedCount",
  "productBatchPreservedCount", "inventoryEntryPreservedCount",
  "inventoryAllocationPreservedCount", "pendingReservationPreservedCount",
  "migrationVersion"
) SELECT
  (SELECT count(*) FROM "pendings" WHERE "legacyBeta"),
  (SELECT count(*) FROM "missing_items" WHERE "legacyBeta"),
  (SELECT count(*) FROM "product_batches"),
  (SELECT count(*) FROM "inventory_entries"),
  (SELECT count(*) FROM "inventory_allocations"),
  (SELECT count(*) FROM "pending_inventory_reservations"),
  '20260901210000_add_inventory_cutover_marker';

CREATE FUNCTION inventory_cutover_state() RETURNS TEXT
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  marker_count INTEGER;
  marker_state TEXT;
BEGIN
  SELECT count(*) INTO marker_count FROM "inventory_cutovers";
  IF marker_count <> 1 THEN
    RAISE EXCEPTION 'Inventory cutover marker is missing or duplicated';
  END IF;

  SELECT "state"::text INTO marker_state FROM "inventory_cutovers" WHERE "id" = 1 FOR SHARE;
  IF marker_state IS NULL OR marker_state NOT IN ('PREPARED', 'ACTIVATED', 'LOCKED') THEN
    RAISE EXCEPTION 'Inventory cutover marker has an unknown state';
  END IF;
  RETURN marker_state;
END;
$$;

CREATE FUNCTION guard_legacy_inventory_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF inventory_cutover_state() IN ('ACTIVATED', 'LOCKED') THEN
    RAISE EXCEPTION 'Inventory cutover marker blocks % on %', TG_OP, TG_TABLE_NAME;
  END IF;
  IF TG_LEVEL = 'ROW' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION guard_legacy_history_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  marker_state TEXT;
BEGIN
  marker_state := inventory_cutover_state();
  IF marker_state IN ('ACTIVATED', 'LOCKED') THEN
    IF TG_OP = 'TRUNCATE' OR
       (TG_OP = 'INSERT' AND NEW."legacyBeta") OR
       (TG_OP = 'UPDATE' AND (OLD."legacyBeta" OR NEW."legacyBeta")) OR
       (TG_OP = 'DELETE' AND OLD."legacyBeta") THEN
      RAISE EXCEPTION 'Inventory cutover marker blocks % on legacy row in %', TG_OP, TG_TABLE_NAME;
    END IF;
  END IF;
  IF TG_LEVEL = 'ROW' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION guard_inventory_cutover_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'Inventory cutover marker singleton cannot be %', lower(TG_OP);
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."migrationVersion" <> OLD."migrationVersion" OR
     NEW."pendingMarkedCount" <> OLD."pendingMarkedCount" OR NEW."missingItemMarkedCount" <> OLD."missingItemMarkedCount" OR
     NEW."productBatchPreservedCount" <> OLD."productBatchPreservedCount" OR NEW."inventoryEntryPreservedCount" <> OLD."inventoryEntryPreservedCount" OR
     NEW."inventoryAllocationPreservedCount" <> OLD."inventoryAllocationPreservedCount" OR NEW."pendingReservationPreservedCount" <> OLD."pendingReservationPreservedCount" OR
     NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Inventory cutover marker metadata is immutable';
  END IF;
  IF NEW."state" = OLD."state" THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Inventory cutover marker metadata is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."state" = 'PREPARED' AND NEW."state" = 'ACTIVATED' AND NEW."cutoverAt" IS NOT NULL AND NEW."activatedById" IS NOT NULL AND NEW."lockedAt" IS NULL THEN RETURN NEW; END IF;
  IF OLD."state" = 'ACTIVATED' AND NEW."state" = 'LOCKED' AND NEW."cutoverAt" = OLD."cutoverAt" AND NEW."activatedById" = OLD."activatedById" AND NEW."lockedAt" IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Invalid inventory cutover state transition from % to %', OLD."state", NEW."state";
END;
$$;

CREATE TRIGGER inventory_cutover_transition_guard
BEFORE INSERT OR UPDATE OR DELETE ON "inventory_cutovers"
FOR EACH ROW EXECUTE FUNCTION guard_inventory_cutover_transition();
CREATE TRIGGER inventory_cutover_truncate_guard
BEFORE TRUNCATE ON "inventory_cutovers"
FOR EACH STATEMENT EXECUTE FUNCTION guard_inventory_cutover_transition();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['product_batches', 'inventory_entries', 'inventory_allocations', 'pending_inventory_reservations'] LOOP
    EXECUTE format('CREATE TRIGGER %I_cutover_row_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_legacy_inventory_write()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_cutover_truncate_guard BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION guard_legacy_inventory_write()', table_name, table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['pendings', 'missing_items'] LOOP
    EXECUTE format('CREATE TRIGGER %I_cutover_row_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_legacy_history_write()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_cutover_truncate_guard BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION guard_legacy_history_write()', table_name, table_name);
  END LOOP;
END;
$$;

COMMIT;

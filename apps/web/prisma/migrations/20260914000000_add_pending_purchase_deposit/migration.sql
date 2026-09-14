-- Purchase deposit typed by hand on a pending.
--
-- Where management ordered the product ("N1", "N3", "Depósito 2"). Free text,
-- no catalog. Only roles with `canManagePurchaseDeposit` read or write it; the
-- list queries select the column only for them.
--
-- Additive and nullable on purpose: no default and no backfill. Every pending
-- that predates this column simply has no deposit, and nothing is invented for
-- the past.
ALTER TABLE "pendings" ADD COLUMN "purchaseDeposit" TEXT;

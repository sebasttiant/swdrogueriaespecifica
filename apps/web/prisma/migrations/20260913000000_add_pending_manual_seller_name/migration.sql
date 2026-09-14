-- Seller name typed by hand on a pending.
--
-- Shared accounts (the counter computers) have no fixed profile, so whoever
-- captures the pending may type who attended the customer. It is descriptive
-- only: ownership, scope and permissions keep coming from "createdById".
--
-- Additive and nullable on purpose: no default and no backfill. Every pending
-- that predates this column simply has no typed seller, and nothing is invented
-- for the past.
ALTER TABLE "pendings" ADD COLUMN "manualSellerName" TEXT;

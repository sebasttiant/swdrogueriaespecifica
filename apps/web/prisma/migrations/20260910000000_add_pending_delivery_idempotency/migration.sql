-- Idempotency key on a partial/total delivery of a pending.
--
-- Additive and nullable on purpose: no existing row is touched, and no
-- backfill runs. Every delivery that predates this column keeps its NULL
-- forever, and in PostgreSQL a unique index admits any number of NULLs, so
-- the historical rows never collide with each other or with a future one.
--
-- Same shape as `pendings.idempotencyKey` (see
-- 20260803120000_add_pending_idempotency_key): a duplicate submit of the SAME
-- delivery attempt (double tap, or a browser resend after a timeout) must not
-- register twice, and the unique index is what makes that guarantee hold even
-- if a future caller skips the row lock the service already takes.
ALTER TABLE "pending_deliveries" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "pending_deliveries_idempotencyKey_key" ON "pending_deliveries"("idempotencyKey");

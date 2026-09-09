-- Management observation on a pending.
--
-- Additive and nullable on purpose: every pending that predates this column
-- keeps working without one, and nothing has to be invented for the past.
--
-- The version counter starts at 0 for existing rows, which is exactly what the
-- seller-facing notice needs: no historical row is born already announcing an
-- observation nobody wrote.
ALTER TABLE "pendings" ADD COLUMN "managementObservation" TEXT;
ALTER TABLE "pendings" ADD COLUMN "managementObservationVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "pendings" ADD COLUMN "managementObservationAt" TIMESTAMP(3);
ALTER TABLE "pendings" ADD COLUMN "managementObservationById" TEXT;

ALTER TABLE "pendings"
  ADD CONSTRAINT "pendings_managementObservationById_fkey"
  FOREIGN KEY ("managementObservationById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The author and the timestamp only mean something when there is text, and the
-- version may never walk backwards past what the text says about itself.
ALTER TABLE "pendings"
  ADD CONSTRAINT "pendings_observation_needs_author"
  CHECK (
    ("managementObservation" IS NULL)
    OR ("managementObservationAt" IS NOT NULL AND "managementObservationVersion" > 0)
  );

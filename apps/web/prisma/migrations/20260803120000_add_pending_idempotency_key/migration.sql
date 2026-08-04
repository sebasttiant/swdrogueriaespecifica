-- Clave de idempotencia del intento que creó el pendiente.
--
-- ADITIVA Y REVERSIBLE: agrega una columna nullable y su índice único. No
-- reescribe ni borra ninguna fila existente. Los pendientes anteriores quedan
-- con NULL, y en PostgreSQL un índice único admite varios NULL, así que la
-- historia previa no necesita ninguna clave inventada.
--
-- Rollback:
--   DROP INDEX "pendings_idempotencyKey_key";
--   ALTER TABLE "pendings" DROP COLUMN "idempotencyKey";

ALTER TABLE "pendings" ADD COLUMN "idempotencyKey" TEXT;

-- The fingerprint binds a reusable key to the normalized actor and full
-- semantic payload. It remains nullable so historical rows need no invented
-- value; every new idempotent Pending writes it.
ALTER TABLE "pendings" ADD COLUMN "requestFingerprint" TEXT;

CREATE UNIQUE INDEX "pendings_idempotencyKey_key" ON "pendings"("idempotencyKey");

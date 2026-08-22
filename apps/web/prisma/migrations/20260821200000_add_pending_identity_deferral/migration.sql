-- S2b · 1a: aplazamiento de identidad al capturar un pendiente.
--
-- ADITIVA y sin backfill: no toca columnas existentes, no define defaults ni
-- reescribe filas. Los previos quedan en NULL = "no se aplazó". Va antes del código.
--
-- El marcador vive en el PENDIENTE: es un hecho de ESTA venta, con su motivo y
-- su momento. En `Product` no hay dónde ponerlos, cuarenta capturas ciegas del
-- mismo producto colapsarían en una fila, y `skuStatus` ata PROVISIONAL_REVIEW
-- a un `internalSku` acuñado.

CREATE TYPE "PendingIdentityDeferral" AS ENUM (
  'ORION_UNAVAILABLE',
  'CODE_NOT_FOUND',
  'CODE_ALREADY_ASSIGNED',
  'OTHER'
);

ALTER TABLE "pendings" ADD COLUMN "identitySkippedReason" "PendingIdentityDeferral";
ALTER TABLE "pendings" ADD COLUMN "identitySkippedNote" TEXT;

-- Índices PARCIALES: uno total crecería con el mostrador entero en vez de con
-- el trabajo por resolver. Prisma no expresa `WHERE` en `@@index`, así que
-- viven acá y NO en el esquema: `migrate diff` los verá como deriva
-- intencional. Dos, porque hay dos audiencias (D8): gerencia agrupa por
-- producto, el autor filtra primero por creador.
CREATE INDEX "pendings_identity_deferred_product_idx"
  ON "pendings" ("productId")
  WHERE "identitySkippedReason" IS NOT NULL;

CREATE INDEX "pendings_identity_deferred_creator_product_idx"
  ON "pendings" ("createdById", "productId")
  WHERE "identitySkippedReason" IS NOT NULL;

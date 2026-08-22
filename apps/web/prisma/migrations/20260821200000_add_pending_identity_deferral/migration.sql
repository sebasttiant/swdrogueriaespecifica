-- S2b · 1a: aplazamiento de identidad al capturar un pendiente.
--
-- ADITIVA, sin backfill: los previos quedan en NULL = "no se aplazó".
--
-- ROLLBACK: nunca borrando este archivo. Una vez aplicada queda registrada en
-- `_prisma_migrations`; sacarla del repositorio no deshace nada y rompe la suma
-- de verificación. Revertir el código alcanza —las columnas son nullables y
-- nadie las lee—; quitarlas físicamente exige una migración FORWARD posterior,
-- y solo tras confirmar que nadie necesita el historial.
--
-- Todo el DDL en UNA transacción: sin eso, un fallo a mitad dejaría el tipo
-- creado y las columnas no, con la migración marcada como aplicada.

BEGIN;

CREATE TYPE "PendingIdentityDeferral" AS ENUM (
  'ORION_UNAVAILABLE',
  'CODE_NOT_FOUND',
  'CODE_ALREADY_ASSIGNED',
  'OTHER'
);

ALTER TABLE "pendings" ADD COLUMN "identitySkippedReason" "PendingIdentityDeferral";
ALTER TABLE "pendings" ADD COLUMN "identitySkippedNote" TEXT;

-- Índices PARCIALES: uno total crecería con el mostrador entero, no con el
-- trabajo por resolver. Prisma no expresa `WHERE` en `@@index`, así que viven
-- acá y NO en el esquema: `migrate diff` los verá como deriva intencional. Dos,
-- por las dos audiencias (D8): gerencia agrupa por producto, el autor por creador.
CREATE INDEX "pendings_identity_deferred_product_idx"
  ON "pendings" ("productId")
  WHERE "identitySkippedReason" IS NOT NULL;

CREATE INDEX "pendings_identity_deferred_creator_product_idx"
  ON "pendings" ("createdById", "productId")
  WHERE "identitySkippedReason" IS NOT NULL;

COMMIT;

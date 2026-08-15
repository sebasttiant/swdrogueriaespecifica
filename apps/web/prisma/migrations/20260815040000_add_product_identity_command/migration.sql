-- Clave e huella del comando que acuñó la identidad del producto.
--
-- ADITIVA Y REVERSIBLE: dos columnas nulables y un índice único. No reescribe
-- ni borra ninguna fila. El catálogo previo queda con NULL, y en PostgreSQL un
-- índice único admite varios NULL, así que la historia no necesita ninguna
-- clave inventada. Mismo patrón que `pendings.idempotencyKey`.
--
-- Rollback:
--   DROP INDEX "products_identityCommandKey_key";
--   ALTER TABLE "products" DROP COLUMN "identityCommandKey";
--   ALTER TABLE "products" DROP COLUMN "identityCommandFingerprint";

ALTER TABLE "products" ADD COLUMN "identityCommandKey" TEXT;

-- La huella ata una clave reutilizable al contenido real del comando: la misma
-- clave con otro contenido es un error del llamador, no un reintento.
ALTER TABLE "products" ADD COLUMN "identityCommandFingerprint" TEXT;

CREATE UNIQUE INDEX "products_identityCommandKey_key" ON "products"("identityCommandKey");

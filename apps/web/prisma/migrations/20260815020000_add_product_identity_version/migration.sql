-- Versión de identidad del producto: el contador del compare-and-set que
-- protege el vínculo con el código Orion.
--
-- ADITIVA Y REVERSIBLE: agrega una columna con valor por defecto constante. En
-- PostgreSQL eso no reescribe la tabla, así que el catálogo existente arranca
-- en 0 sin costo ni bloqueo largo.
--
-- Rollback:
--   ALTER TABLE "products" DROP COLUMN "identityVersion";

ALTER TABLE "products" ADD COLUMN "identityVersion" INTEGER NOT NULL DEFAULT 0;

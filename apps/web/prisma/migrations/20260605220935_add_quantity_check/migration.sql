-- Integridad de datos: la cantidad de un lote nunca puede ser negativa.
-- 0 es válido (lote agotado, estado derivado). Negativo solo podría venir de un
-- bug de sobre-descuento; esta red lo atrapa en la base, sin importar el código.
-- (Prisma no soporta CHECK en el DSL del schema; por eso va como SQL crudo.)
ALTER TABLE "product_batches"
  ADD CONSTRAINT "product_batches_quantity_nonneg" CHECK ("quantity" >= 0);

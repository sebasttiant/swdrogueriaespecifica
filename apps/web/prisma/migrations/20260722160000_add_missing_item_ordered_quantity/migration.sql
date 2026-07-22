-- Cantidad real que gerencia pidió al proveedor. Aditiva y nullable: las filas
-- existentes quedan en NULL (no se infiere ni se copia `quantity`, que tiene un
-- significado distinto: necesidad/déficit histórico). Los pedidos anteriores a
-- esta columna se mostrarán como "Cantidad pedida no registrada".
ALTER TABLE "missing_items" ADD COLUMN "orderedQuantity" INTEGER;

-- Integridad en la base: si hay cantidad pedida, es positiva. NULL sigue siendo
-- válido (faltante abierto o registro histórico). Misma técnica que
-- `product_batches_quantity_nonneg` (Prisma no expresa CHECK en el DSL).
ALTER TABLE "missing_items"
  ADD CONSTRAINT "missing_items_ordered_quantity_positive"
  CHECK ("orderedQuantity" IS NULL OR "orderedQuantity" > 0);

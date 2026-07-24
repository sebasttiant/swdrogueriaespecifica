-- Descarte de un faltante: gerencia marca como CANCELADO lo duplicado o lo que
-- ya no hace falta. Dos vendedores anotando el mismo producto es el caso más
-- común, y hasta ahora la única salida era pedirlo —lo que dejaba en la base
-- una orden a un proveedor inexistente—.
--
-- Columnas PROPIAS, no reutilizando `confirmedAt`/`confirmedById`. Sobrecargar
-- un campo cuyo nombre significa otra cosa es lo que obligó a revertir "OK
-- gerencia": después nadie puede decir si esa fecha fue una confirmación o un
-- descarte, y toda consulta que filtre por `confirmedAt` empieza a mentir.
--
-- ADITIVA y nullable: las filas existentes quedan en NULL, que es la verdad
-- (ninguna fue descartada). El valor CANCELADO ya existe en el enum, así que
-- esta migración no lo toca.
ALTER TABLE "missing_items" ADD COLUMN "discardedAt" TIMESTAMP(3);
ALTER TABLE "missing_items" ADD COLUMN "discardedById" TEXT;
ALTER TABLE "missing_items" ADD COLUMN "discardReason" TEXT;

-- RESTRICT como el resto de las relaciones de responsabilidad del modelo: un
-- usuario que descartó faltantes no se puede borrar dejando el registro sin
-- responsable. La trazabilidad de quién descartó qué es justo el punto.
ALTER TABLE "missing_items"
  ADD CONSTRAINT "missing_items_discardedById_fkey"
  FOREIGN KEY ("discardedById") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

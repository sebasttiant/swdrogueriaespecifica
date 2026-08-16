-- Índice compuesto para la derivación de cantidades (T1.4).
--
-- `activeReserved` suma los movimientos de reserva de UN lote. Sin este índice
-- esa suma recorre todos los movimientos del lote y descarta por tipo, y el
-- ledger se retiene de forma permanente (D4): ese recorrido crece para siempre
-- y la lectura de disponibilidad se degrada con la antigüedad del lote.
CREATE INDEX "inventory_movements_lotId_type_idx" ON "inventory_movements"("lotId", "type");

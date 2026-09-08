-- Cierra los rieles que quedaron abiertos colgando de un pedido ya terminado.
--
-- El defecto vivió en `deliverPending`: entregar no cancelaba el `MissingItem`,
-- a diferencia de cancelar y de cerrar parcial, que sí lo hacen en su misma
-- transacción. El código ya quedó arreglado; esto limpia lo que dejó.
--
-- Medido en producción el 2026-09-07: 13 de los 16 faltantes que contaba el chip
-- de abastecimiento colgaban de pedidos ENTREGADOS. Además de inflar el número,
-- seguían siendo candidatos del cierre FIFO: la próxima entrada de esos
-- productos les habría reservado stock a pedidos ya entregados.
--
-- Se marcan CANCELADO, que es exactamente lo que escribe la cancelación de un
-- pendiente para sus rieles. No se borra nada: la fila conserva su historia
-- —quién la creó, si se le pidió al proveedor y cuándo— y deja de ser trabajo.
UPDATE "missing_items" mi
SET "status" = 'CANCELADO', "updatedAt" = now()
FROM "pendings" pe
WHERE pe."id" = mi."originId"
  AND mi."status" IN ('FALTANTE', 'PEDIDO', 'EN_BODEGA')
  AND pe."status" IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL');

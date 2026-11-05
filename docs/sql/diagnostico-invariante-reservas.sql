-- Read-only diagnosis for issue #332 (inventory reservation invariant).
-- Paste inside psql. The transaction is READ ONLY: any write fails.
BEGIN TRANSACTION READ ONLY;
\pset pager off

-- 1. Live reservation rows of open pendings, classified by origin.
--    RECEPTION  = created in the same transaction as an inventory allocation
--                 for that pending (legacy code subtracted it from the batch).
--    SOFT       = no matching allocation (reconciliation; never subtracted).
WITH live AS (
  SELECT pir.id, pir."pendingId", pir."batchId", pir.quantity, pir."createdAt",
         pb."productId" AS batch_product, p."productId" AS pending_product,
         p.status
  FROM pending_inventory_reservations pir
  JOIN pendings p ON p.id = pir."pendingId"
  JOIN product_batches pb ON pb.id = pir."batchId"
), classified AS (
  SELECT l.*,
         CASE WHEN EXISTS (
           SELECT 1 FROM inventory_allocations ia
           WHERE ia."pendingId" = l."pendingId"
             AND abs(extract(epoch FROM ia."createdAt" - l."createdAt")) < 5
         ) THEN 'RECEPTION' ELSE 'SOFT' END AS origin
  FROM live l
)
SELECT origin,
       status IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL') AS terminal,
       batch_product <> pending_product AS product_mismatch,
       count(*) AS rows,
       sum(quantity) AS units
FROM classified
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- 2. Open pendings whose ready claim is not covered by live reservations.
SELECT count(*) AS pendings,
       sum(p."inventoryReadyQuantity" - p."deliveredQuantity"
           - COALESCE(r.live, 0)) AS uncovered_units
FROM pendings p
LEFT JOIN (
  SELECT "pendingId", sum(quantity) AS live
  FROM pending_inventory_reservations GROUP BY 1
) r ON r."pendingId" = p.id
WHERE p.status NOT IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL')
  AND p."inventoryReadyQuantity" - p."deliveredQuantity" > COALESCE(r.live, 0);

-- 3. Deliveries recorded after #328 (2026-10-31): soft reservations consumed
--    then never subtracted the physical batch.
SELECT count(*) AS deliveries, COALESCE(sum(d.quantity), 0) AS units
FROM pending_deliveries d
WHERE d."deliveredAt" >= TIMESTAMP '2026-10-31 00:00:00'
  AND NOT EXISTS (
    SELECT 1 FROM inventory_allocations ia WHERE ia."pendingId" = d."pendingId"
  );

-- 4. Products affected (any of the above), to size the repair.
SELECT count(DISTINCT p."productId") AS products
FROM pendings p
WHERE p.status NOT IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL')
  AND (p."inventoryReadyQuantity" > p."deliveredQuantity"
       OR EXISTS (SELECT 1 FROM pending_inventory_reservations r
                  WHERE r."pendingId" = p.id));

ROLLBACK;

#!/usr/bin/env bash
# --------------------------------------------------------------------------
# GLAUCOMED over-claim repair (authorized by gerencia only).
#
# Pending cmvtwbgzg053t01oh6q8s8lhy was invoiced for 15 while physical
# DISPONIBLE stock is only 5. The app cannot clamp inventoryReadyQuantity
# below invoicedQuantity (DB CHECK).
#
# Authorized ops path:
#   1) Deliver the 5 units that exist (batch qty -= 5, PendingDelivery +5).
#   2) Close the remaining 10 as CLOSED_PARTIAL (client no longer waits).
#   3) Write audit. Leave missing rails cancelled.
#
# Default is DRY-RUN (SELECT only). Apply requires BOTH flags below.
#
# Usage (on the VPS, from the compose project directory):
#   ./scripts/repair-glaucomed-overclaim.sh
#   DEPLOY_TARGET=vpsovhcloudilasesorias \
#   CONFIRM_GLAUCOMED_REPAIR=apply-glaucomed-overclaim \
#     ./scripts/repair-glaucomed-overclaim.sh --apply
# --------------------------------------------------------------------------
set -Eeuo pipefail

PENDING_ID="${PENDING_ID:-cmvtwbgzg053t01oh6q8s8lhy}"
EXPECTED_QTY="${EXPECTED_QTY:-15}"
EXPECTED_INVOICED="${EXPECTED_INVOICED:-15}"
EXPECTED_STOCK="${EXPECTED_STOCK:-5}"
DELIVER_QTY="${DELIVER_QTY:-5}"
DEPLOY_TARGET="${DEPLOY_TARGET:-}"
CONFIRM_GLAUCOMED_REPAIR="${CONFIRM_GLAUCOMED_REPAIR:-}"
MODE="${1:-}"

usage() {
  cat >&2 <<'USAGE'
Usage:
  ./scripts/repair-glaucomed-overclaim.sh
  DEPLOY_TARGET=<hostname> CONFIRM_GLAUCOMED_REPAIR=apply-glaucomed-overclaim \
    ./scripts/repair-glaucomed-overclaim.sh --apply

Dry-run is the default. --apply writes only with both confirmations.
USAGE
  exit 2
}

[[ -z "$MODE" || "$MODE" == "--apply" ]] || usage

if [[ -n "$DEPLOY_TARGET" ]]; then
  ACTUAL_HOST="$(hostname)"
  if [[ -z "$ACTUAL_HOST" || "$ACTUAL_HOST" != "$DEPLOY_TARGET" ]]; then
    echo "ERROR: este servidor es '$ACTUAL_HOST' y DEPLOY_TARGET='$DEPLOY_TARGET'." >&2
    exit 1
  fi
fi

APPLY=0
if [[ "$MODE" == "--apply" ]]; then
  if [[ "$CONFIRM_GLAUCOMED_REPAIR" != "apply-glaucomed-overclaim" ]]; then
    echo "ERROR: --apply exige CONFIRM_GLAUCOMED_REPAIR=apply-glaucomed-overclaim." >&2
    exit 2
  fi
  if [[ -z "$DEPLOY_TARGET" ]]; then
    echo "ERROR: --apply exige DEPLOY_TARGET=<hostname>." >&2
    exit 2
  fi
  APPLY=1
  echo "==> APPLY: se escribirá la reparación de GLAUCOMED ($PENDING_ID)."
else
  echo "==> DRY-RUN: no se escribirán datos."
fi

# shellcheck disable=SC2016
DIAG_SQL=$(cat <<SQL
SELECT pe.id,
       pe."customerName",
       pe.quantity,
       pe."inventoryReadyQuantity",
       pe."reservedInventoryQuantity",
       pe."invoicedQuantity",
       pe."deliveredQuantity",
       pe."cancelledQuantity",
       pe.status,
       pe."availabilityStatus",
       pe."customerStatus",
       p.name,
       p."orionCode",
       coalesce((
         SELECT sum(b.quantity) FROM product_batches b
         WHERE b."productId" = pe."productId" AND b.status = 'DISPONIBLE'
       ), 0) AS stock_disponible,
       coalesce((
         SELECT sum(r.quantity) FROM pending_inventory_reservations r
         WHERE r."pendingId" = pe.id
       ), 0) AS reserved_rows
FROM pendings pe
JOIN products p ON p.id = pe."productId"
WHERE pe.id = '${PENDING_ID}';
SQL
)

echo "==> Estado actual"
docker compose exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<<"$DIAG_SQL"

if [[ "$APPLY" -ne 1 ]]; then
  echo
  echo "Para aplicar cuando gerencia autorice:"
  echo "  DEPLOY_TARGET=\$(hostname) CONFIRM_GLAUCOMED_REPAIR=apply-glaucomed-overclaim \\"
  echo "    ./scripts/repair-glaucomed-overclaim.sh --apply"
  exit 0
fi

# shellcheck disable=SC2016
APPLY_SQL=$(cat <<SQL
BEGIN;

DO \$\$
DECLARE
  pending_id text := '${PENDING_ID}';
  expected_qty int := ${EXPECTED_QTY};
  expected_invoiced int := ${EXPECTED_INVOICED};
  expected_stock int := ${EXPECTED_STOCK};
  deliver_qty int := ${DELIVER_QTY};
  cancel_qty int;
  product_id text;
  ready int;
  invoiced int;
  delivered int;
  cancelled int;
  qty int;
  status text;
  customer_status text;
  stock int;
  actor text;
  batch_id text;
  batch_qty int;
  take int;
  left_to_reserve int;
  delivery_id text := 'cmdel' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
  audit_id text := 'cmaud' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
  res_id text;
BEGIN
  cancel_qty := expected_qty - deliver_qty;

  SELECT pe."productId", pe.quantity, pe."inventoryReadyQuantity",
         pe."invoicedQuantity", pe."deliveredQuantity", pe."cancelledQuantity",
         pe.status::text, pe."customerStatus"::text
    INTO product_id, qty, ready, invoiced, delivered, cancelled, status, customer_status
    FROM pendings pe
   WHERE pe.id = pending_id
   FOR UPDATE;

  IF product_id IS NULL THEN
    RAISE EXCEPTION 'pending % not found', pending_id;
  END IF;

  IF qty IS DISTINCT FROM expected_qty
     OR invoiced IS DISTINCT FROM expected_invoiced
     OR delivered IS DISTINCT FROM 0
     OR coalesce(cancelled, 0) IS DISTINCT FROM 0
     OR status IS DISTINCT FROM 'PENDIENTE' THEN
    RAISE EXCEPTION
      'Guard failed: qty=%, invoiced=%, delivered=%, cancelled=%, status=% (expected %/% /0/0/PENDIENTE)',
      qty, invoiced, delivered, cancelled, status, expected_qty, expected_invoiced;
  END IF;

  IF customer_status IS DISTINCT FROM 'FACTURADO' THEN
    RAISE EXCEPTION 'customerStatus=% (expected FACTURADO)', customer_status;
  END IF;

  SELECT coalesce(sum(b.quantity), 0)::int INTO stock
    FROM product_batches b
   WHERE b."productId" = product_id AND b.status = 'DISPONIBLE';

  IF stock IS DISTINCT FROM expected_stock THEN
    RAISE EXCEPTION 'stock_disponible=% (expected %)', stock, expected_stock;
  END IF;

  SELECT u.id INTO actor
    FROM users u
   WHERE lower(u.email) = 'admin@ilasesorias.com' AND u.active = true
   LIMIT 1;
  IF actor IS NULL THEN
    SELECT u.id INTO actor FROM users u
     WHERE u.role IN ('SUPERADMIN', 'ADMIN') AND u.active = true
     ORDER BY u."createdAt" ASC LIMIT 1;
  END IF;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'No active ADMIN/SUPERADMIN actor';
  END IF;

  -- Drop stale reservation rows; rebuild exactly deliver_qty against real lots.
  DELETE FROM pending_inventory_reservations WHERE "pendingId" = pending_id;

  left_to_reserve := deliver_qty;
  FOR batch_id, batch_qty IN
    SELECT b.id, b.quantity
      FROM product_batches b
     WHERE b."productId" = product_id
       AND b.status = 'DISPONIBLE'
       AND b.quantity > 0
     ORDER BY b."expiresAt" ASC NULLS LAST, b.id ASC
     FOR UPDATE
  LOOP
    EXIT WHEN left_to_reserve <= 0;
    take := LEAST(batch_qty, left_to_reserve);
    res_id := 'cmres' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
    INSERT INTO pending_inventory_reservations (
      id, "pendingId", "batchId", quantity, "createdAt"
    ) VALUES (res_id, pending_id, batch_id, take, now());
    UPDATE product_batches
       SET quantity = quantity - take
     WHERE id = batch_id;
    left_to_reserve := left_to_reserve - take;
  END LOOP;

  IF left_to_reserve <> 0 THEN
    RAISE EXCEPTION 'Could not reserve/deliver % units; short by %', deliver_qty, left_to_reserve;
  END IF;

  INSERT INTO pending_deliveries (
    id, "pendingId", quantity, "deliveredById", "deliveredAt", "idempotencyKey"
  ) VALUES (
    delivery_id,
    pending_id,
    deliver_qty,
    actor,
    now(),
    'glaucomed-overclaim-deliver-' || pending_id
  );

  -- Consume reservation rows (batches already decremented above).
  DELETE FROM pending_inventory_reservations WHERE "pendingId" = pending_id;

  -- One write: deliver physical stock and close the unpaid remainder.
  -- inventoryReady drops to what was actually handed over; CLOSED_PARTIAL
  -- removes this pending from claimableStock aggregates.
  UPDATE pendings
     SET "deliveredQuantity" = deliver_qty,
         "cancelledQuantity" = cancel_qty,
         status = 'CLOSED_PARTIAL',
         "customerStatus" = 'ENTREGADO',
         "inventoryReadyQuantity" = deliver_qty,
         "reservedInventoryQuantity" = deliver_qty,
         "availabilityStatus" = 'DISPONIBLE_PARCIAL',
         "completedAt" = now(),
         "cancelReason" = format(
           'Cerrado sin los %s restantes tras autorización de gerencia (over-claim GLAUCOMED: facturado %s, stock físico %s)',
           cancel_qty, expected_invoiced, expected_stock
         )
   WHERE id = pending_id;

  UPDATE missing_items
     SET status = 'CANCELADO', "updatedAt" = now()
   WHERE "originId" = pending_id
     AND status IN ('FALTANTE', 'PEDIDO', 'EN_BODEGA');

  INSERT INTO audit_logs (
    id, "userId", action, module, entity, "entityId", result, before, after, "createdAt"
  ) VALUES (
    audit_id,
    actor,
    'pending.update',
    'pendientes',
    'Pending',
    pending_id,
    'SUCCESS',
    jsonb_build_object(
      'quantity', qty,
      'invoicedQuantity', invoiced,
      'deliveredQuantity', 0,
      'inventoryReadyQuantity', ready,
      'stockDisponible', stock,
      'status', status
    ),
    jsonb_build_object(
      'deliveredQuantity', deliver_qty,
      'cancelledQuantity', cancel_qty,
      'status', 'CLOSED_PARTIAL',
      'inventoryReadyQuantity', deliver_qty,
      'reason', 'Authorized GLAUCOMED over-claim repair: deliver physical stock, close remainder'
    ),
    now()
  );
END \$\$;

COMMIT;

SELECT pe.id, pe."customerName", pe.quantity,
       pe."invoicedQuantity", pe."deliveredQuantity", pe."cancelledQuantity",
       pe.status, pe."availabilityStatus", pe."customerStatus",
       coalesce((
         SELECT sum(b.quantity) FROM product_batches b
         WHERE b."productId" = pe."productId" AND b.status = 'DISPONIBLE'
       ), 0) AS stock_disponible
FROM pendings pe
WHERE pe.id = '${PENDING_ID}';
SQL
)

docker compose exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<<"$APPLY_SQL"

echo "==> Reparación aplicada."

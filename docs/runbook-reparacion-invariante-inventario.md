# Runbook: reparación del invariante de inventario (#332)

Reparación única. Convierte los datos que dejó el código anterior al modelo
nuevo: **el lote es siempre el total físico y las reservas son un subconjunto**.

## Qué corrige

| Antes | Después |
| --- | --- |
| La recepción restaba del lote las unidades reservadas | Esas unidades vuelven al lote (siguen en el estante) |
| El alta de un pendiente prometía stock sin reserva por lote | Cada promesa se reconstruye contra el stock físico, del pendiente más viejo al más nuevo |
| Promesas sin respaldo físico | Se recortan, el pendiente vuelve a `ESPERANDO` o `DISPONIBLE_PARCIAL` y se crea el faltante |

Todo queda auditado (`inventory.invariant.restore`, `pending.update`) en la
misma transacción.

## Cuándo se bloquea (no escribe nada)

- Una reserva sin evidencia de recepción.
- Una reserva de un pendiente terminado o de un lote de otro producto.
- Un lote con un ajuste físico (`inventory.adjust`) posterior a la reserva.

Esos casos requieren revisión humana; la herramienta no adivina.

## Ventana operativa

El código nuevo y la reparación salen juntos. Entre el deploy y el `--apply`
el código nuevo lee lotes que todavía tienen unidades restadas: **no entregar
ni facturar pendientes en esa ventana**. Hacerlo fuera del horario de atención
y aplicar inmediatamente después del deploy.

## Pasos (en el VPS de producción)

```bash
cd /opt/docker/swdrogueriaespecifica
```

1. Obtener el id del actor (dentro de `psql`):

   ```sql
   SELECT id FROM users WHERE lower(email) = 'admin@ilasesorias.com';
   ```

2. Simulación (no escribe nada). Revisar unidades devueltas y pendientes
   reconciliados; copiar la línea `Huella:`.

   ```bash
   DEPLOY_TARGET=vpsovhcloudilasesorias \
     ./scripts/run-inventory-invariant-repair.sh <actor id>
   ```

3. Aplicar con la huella revisada:

   ```bash
   DEPLOY_TARGET=vpsovhcloudilasesorias \
   CONFIRM_REPAIR_APPLY=apply-inventory-invariant-repair \
   EXPECTED_FINGERPRINT=<huella> \
     ./scripts/run-inventory-invariant-repair.sh <actor id> --apply
   ```

   Si la base cambió desde la simulación, la huella no coincide y no se escribe
   nada: volver al paso 2.

4. Repetir el paso 3. Debe responder `Estado: noop`.

5. Verificar (dentro de `psql`). Las dos consultas deben devolver 0 filas:

   ```sql
   -- Promesas abiertas que no son exactamente reservas vivas.
   SELECT p.id FROM pendings p
   LEFT JOIN (SELECT "pendingId", sum(quantity) live
              FROM pending_inventory_reservations GROUP BY 1) r ON r."pendingId" = p.id
   WHERE p.status NOT IN ('ENTREGADO','CANCELADO','CLOSED_PARTIAL')
     AND p."inventoryReadyQuantity" - p."deliveredQuantity" <> COALESCE(r.live, 0);

   -- Lotes con más reservado que físico.
   SELECT pb.id FROM product_batches pb
   JOIN pending_inventory_reservations pir ON pir."batchId" = pb.id
   GROUP BY pb.id, pb.quantity HAVING sum(pir.quantity) > pb.quantity;
   ```

## Después

La reparación deja la contabilidad consistente, no reemplaza un conteo. Si
Bodega cuenta un lote y no coincide, se corrige con el ajuste auditado de
inventario, que ahora recorta reservas y crea faltantes solo.

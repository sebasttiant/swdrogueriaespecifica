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

## Marca de corte

La migración `inventory_invariant_cutover` guarda el momento del deploy. La
reparación solo devuelve unidades de reservas **anteriores** a esa marca: una
recepción posterior ya no resta del lote, y devolverla duplicaría stock. Si la
marca no existe, la reparación se bloquea.

## Cuándo se bloquea (no escribe nada)

Solo se evalúan reservas anteriores al corte:

- Una reserva sin evidencia de recepción.
- Una reserva de un pendiente terminado o de un lote de otro producto.
- Un lote con un ajuste físico (`inventory.adjust`) posterior a la reserva.

Esos casos requieren revisión humana; la herramienta no adivina.

## Pendientes sin faltante (solo se listan)

La simulación lista los pendientes abiertos con demanda sin cubrir y sin
ningún faltante. Típicamente son pendientes a los que se les corrigió el
producto antes de #332: quedaban en `ESPERANDO` sin faltante y Bodega no los
veía. La herramienta **no** les crea faltante: gerencia pudo haberlo
descartado a propósito. Revisarlos con gerencia y, si corresponde, volver a
registrar la necesidad desde la aplicación.

## Unidades posiblemente perdidas (solo se listan)

Con el código viejo, cancelar, cerrar parcial o corregir un pendiente que
tenía mercadería recibida borraba la reserva sin devolver las unidades al
lote. No queda ningún registro de qué lote eran, así que la herramienta
**no las inventa**: lista, por producto, cuántas probablemente faltan en el
sistema. Bodega cuenta esos productos y los corrige con el ajuste auditado de
inventario.

## Ventana operativa

El código nuevo y la reparación salen juntos, **con la aplicación apagada**
mientras se repara. Cualquier operación en esa ventana (registrar, recibir,
cancelar, corregir, ajustar, entregar, facturar) cambia los datos que la
reparación revisa. Hacerlo fuera del horario de atención.

## Pasos (en el VPS de producción)

```bash
cd /opt/docker/swdrogueriaespecifica
```

1. Deploy normal con `deploy.sh`. Apenas termina, apagar la aplicación
   (nunca usar `--remove-orphans`):

   ```bash
   docker compose stop web
   ```

2. Obtener el id del actor (dentro de `psql`):

   ```sql
   SELECT id FROM users WHERE lower(email) = 'admin@ilasesorias.com';
   ```

3. Simulación (no escribe nada). Revisar unidades devueltas y pendientes
   reconciliados; copiar la línea `Huella:`.

   ```bash
   DEPLOY_TARGET=vpsovhcloudilasesorias \
     ./scripts/run-inventory-invariant-repair.sh <actor id>
   ```

4. Aplicar con la huella revisada:

   ```bash
   DEPLOY_TARGET=vpsovhcloudilasesorias \
   CONFIRM_REPAIR_APPLY=apply-inventory-invariant-repair \
   EXPECTED_FINGERPRINT=<huella> \
     ./scripts/run-inventory-invariant-repair.sh <actor id> --apply
   ```

   Si la base cambió desde la simulación, la huella no coincide y no se escribe
   nada: volver al paso 3.

5. Repetir el paso 4. Debe responder `Estado: noop`.

6. Verificar (dentro de `psql`). Las dos consultas deben devolver 0 filas:

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

7. Encender la aplicación:

   ```bash
   docker compose start web
   ```

Si la reparación se bloquea, **no encender** la aplicación sin decidirlo con
quien mantiene el sistema: el código nuevo sobre datos sin reparar muestra
menos stock libre del real.

## Después

La reparación deja la contabilidad consistente, no reemplaza un conteo. Si
Bodega cuenta un lote y no coincide, se corrige con el ajuste auditado de
inventario, que ahora recorta reservas y crea faltantes solo.

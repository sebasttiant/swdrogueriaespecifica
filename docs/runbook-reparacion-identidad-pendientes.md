# Runbook — Reparación de identidad duplicada en Pendientes

Reparación auditada del incidente de octubre de 2026: `SEDATIF PC X 40 TABLETAS`
quedó con varios productos manuales indistinguibles, un pendiente atado al
producto equivocado y bodega sin poder recibirlo.

Este runbook **no ejecuta nada en producción por sí mismo**. Cada mutación es
una decisión humana explícita y queda registrada acá.

## Antes de empezar

Lo que esta reparación **no** hace, a propósito:

- No borra filas. Los duplicados quedan desactivados y marcados para revisión.
- No fusiona productos parecidos. Solo toca exactamente lo que el manifiesto nombra.
- No mueve stock ni lotes. El producto que conserva el stock es el que sobrevive.
- No normaliza variantes de código. `A15637`, `A-15637` y `15637` **no** son lo mismo.

Si algo de la base dejó de coincidir con el manifiesto revisado, la herramienta
se detiene con motivos y no escribe. Reparar una base que ya no reconocés es
cómo un incidente se convierte en dos.

## Paso 1 — Desplegar el fix preventivo primero

El fix de la aplicación va **antes** que la reparación de datos. Si entra al
revés, la pantalla sigue creando duplicados mientras limpiás los anteriores.

Orden de los PR encadenados:

1. Recuperación del dueño del código de Orión.
2. Búsqueda completa del catálogo en captura.
3. Prevención de productos manuales duplicados.
4. Herramienta de reparación (este runbook).

## Paso 2 — Backup verificado de producción

En el VPS de producción (`vpsovhcloudilasesorias`):

```bash
bash scripts/backup-data.sh
```

`backup-data.sh` **no** genera el `.sha256`. `restore-data.sh` sí lo busca como
archivo hermano y, si falta, te obliga a aceptar a mano una copia cuya
integridad nadie comprobó. Generá el checksum vos, en el VPS de origen, sobre
el archivo recién creado:

```bash
cd <directorio-del-backup>
sha256sum <archivo.tar.gz> > <archivo.tar.gz>.sha256
sha256sum --check <archivo.tar.gz>.sha256
```

El `cd` no es decorativo. `restore-data.sh` exige que el nombre guardado
dentro del `.sha256` sea el del archivo que le pasás; si generás el sidecar
con una ruta larga, queda esa ruta escrita adentro, en el VPS de pruebas ya no
coincide y el script aborta por formato inválido. Generálo siempre desde el
directorio del backup, con el nombre pelado.

El checksum se calcula **donde se creó el archivo**. Calcularlo después de
copiarlo solo demuestra que el archivo es igual a sí mismo: no detecta una
transferencia corrupta, que es justo lo que el gate existe para detectar.

Verificá antes de seguir:

- El `.tar.gz` existe y `sha256sum --check` responde `OK`.
- El tamaño es coherente con los backups anteriores.

Sin backup verificado, el runbook se detiene acá.

## Paso 3 — Restaurar ese backup en el VPS de pruebas

Copiá al VPS de pruebas (`vpsovhcloudsoprotelco`) **los dos archivos**, el
`.tar.gz` y su `.sha256` hermano. Sin el sidecar, `restore-data.sh` pide
aceptación explícita de integridad no autenticada y el gate del paso 2 queda
sin efecto:

```bash
scp <archivo.tar.gz> <archivo.tar.gz>.sha256 <vps-pruebas>:<destino>/
```

Ya en el VPS de pruebas, con ambos archivos en el mismo directorio:

```bash
bash scripts/restore-data.sh <archivo.tar.gz>
```

El script valida el checksum solo. Si reporta diferencia, la copia se corrompió
en tránsito: volvé a transferir, no sigas.

El dry-run se hace **sobre la copia restaurada**, nunca contra producción.

## Paso 4 — Reconstruir el manifiesto contra la copia restaurada

Los IDs se leen de la base que vas a reparar, no se copian de un documento
viejo. Contra la copia restaurada:

```sql
-- Productos que comparten el nombre del incidente
SELECT id, code, name, "orionCode", active, "needsReview", "createdAt"
  FROM products
 WHERE name ILIKE '%SEDATIF PC%'
 ORDER BY "createdAt";

-- Stock por producto, en LOS DOS modelos de inventario. Mirar solo uno
-- esconde stock en el que el cutover esté usando.
SELECT p.id,
       p.code,
       COALESCE((SELECT SUM(b.quantity) FROM product_batches b
                  WHERE b."productId" = p.id), 0) AS stock_legado,
       COALESCE((SELECT SUM(l."onHand") FROM lots l
                  WHERE l."productId" = p.id), 0) AS stock_canonico,
       (SELECT count(*) FROM inventory_entries e
         WHERE e."productId" = p.id) AS entradas
  FROM products p
 WHERE p.name ILIKE '%SEDATIF PC%'
 ORDER BY p."createdAt";

-- TODOS los pendientes y faltantes ABIERTOS de esos productos. La lista tiene
-- que entrar completa en el manifiesto: la herramienta se niega si queda uno
-- afuera, porque quedaría colgado de un producto desactivado.
SELECT id, "productId", status, quantity FROM pendings
 WHERE "productId" IN (<ids>) AND status IN ('PENDIENTE', 'PARCIAL');
SELECT id, "productId", status, quantity FROM missing_items
 WHERE "productId" IN (<ids>) AND status IN ('FALTANTE', 'PEDIDO', 'EN_BODEGA');
```

Escribí el manifiesto con lo que acabás de leer:

```json
{
  "actorId": "<usuario que ejecuta la reparación>",
  "targetProductId": "<el producto CON stock>",
  "expectedTargetOrionCode": "<el código que tiene AHORA>",
  "canonicalOrionCode": "A15637",
  "duplicateProductIds": ["<duplicados sin stock>"],
  "pendingIds": ["<pendientes abiertos a reasignar>"],
  "missingItemIds": ["<faltantes abiertos a reasignar>"]
}
```

`expectedTargetOrionCode` es la guarda de drift: es lo que afirmás haber visto.
Si la base dice otra cosa cuando ejecutes, la reparación se niega.

## Paso 5 — Dry-run en el VPS de pruebas

```bash
cd /opt/docker/swdrogueriaespecifica
DEPLOY_TARGET=vpsovhcloudsoprotelco \
  ./scripts/run-product-identity-repair.sh repair.json
```

El wrapper comprueba el hostname, valida el JSON, monta el manifiesto en solo
lectura y ejecuta el servicio `repair`. Ese servicio usa la imagen construida
durante el deploy y recibe `DATABASE_URL` y `AUTH_SECRET` desde el `.env`
mediante Compose. No exportes ni imprimas secretos en la terminal.

Sin `--apply` no escribe nada. El plan imprime **cada ID**, no solo cantidades,
porque eso es lo que después vas a comparar contra producción.

**Guardá la salida del dry-run.** Es el artefacto que se compara en el paso 8.

Confirmá que dice exactamente:

- `orionCode`: del código con guion al canónico `A15637`.
- los IDs de pendientes a reasignar que esperabas, uno por uno.
- los IDs de faltantes a reasignar que esperabas, uno por uno.
- los IDs de productos a desactivar que esperabas, uno por uno.

Si aparecen bloqueos, **no fuerces nada**: volvé al paso 4. Los bloqueos son la
herramienta diciendo que la base no es la que vos describiste.

## Paso 6 — Aplicar en el VPS de pruebas

```bash
cd /opt/docker/swdrogueriaespecifica
DEPLOY_TARGET=vpsovhcloudsoprotelco \
CONFIRM_REPAIR_APPLY=apply-product-identity-repair \
  ./scripts/run-product-identity-repair.sh repair.json --apply
```

Repetir este mismo comando después de una aplicación correcta debe devolver
`Estado: noop` y `No había cambios pendientes; no se escribió nada.`

## Paso 7 — Validar el resultado en pruebas

Esto es lo que decide si la reparación sirve. Contra la copia reparada:

- El producto objetivo tiene `orionCode = 'A15637'` y su `identityVersion` subió uno.
- Sus 2 unidades de stock siguen ahí, en el mismo lote.
- Los duplicados no tienen pendientes ni faltantes abiertos colgando.
- El pendiente afectado apunta al producto objetivo.
- El faltante afectado apunta al producto objetivo.
- Los duplicados están `active = false` y siguen existiendo.
- Hay una entrada de auditoría por cada efecto.

Y en la aplicación, con el fix desplegado:

- Bodega puede recibir el pendiente afectado.
- Capturar `SEDATIF PC X 40 TABLETAS` encuentra el producto existente por
  nombre, por código interno y por `A15637`.
- Intentar crearlo como manual muestra la alerta y obliga a elegir o confirmar.

Si algo de esta lista falla, la reparación **no** se lleva a producción.

## Paso 8 — Producción

Solo con el paso 7 completo y aprobado.

### La ventana de mantenimiento abarca TODO el paso 8

El único rollback disponible es restaurar el backup de 8.2, y
`restore-data.sh` hace `DROP DATABASE … WITH (FORCE)` y la recrea: reemplaza
la base **entera**, no solo los productos reparados. Todo lo que se haya
escrito después de ese backup — pendientes de otros clientes, entradas de
mercadería, entregas — desaparece con la vuelta atrás.

Por eso la ventana **no** es "nadie toca esos productos mientras corre la
reparación". Es una ventana de mantenimiento **de toda la base**, que abre
**antes** del backup de rollback y cierra recién cuando la validación en
producción terminó bien. Fuera de esa regla, revertir destruye trabajo
legítimo de gente que no tuvo nada que ver con el incidente.

En la práctica: elegí un horario sin operación, avisá al mostrador y a bodega,
y no reabras hasta el punto 8.8.

1. **Abrir la ventana de mantenimiento de toda la base.** Nadie escribe:
   ni Call Center, ni bodega, ni gerencia. Desde acá hasta 8.8.
2. Backup fresco de producción (`scripts/backup-data.sh`) **con la ventana ya
   abierta**, más su `.sha256` generado y verificado como en el paso 2. Este
   es el backup de rollback: si se toma antes de cerrar las escrituras, no
   sirve para revertir sin pérdida.
3. Reconstruir el manifiesto **contra producción** corriendo de nuevo las
   consultas del paso 4. No se copian los IDs del manifiesto de pruebas: la
   copia restaurada y producción divergieron desde el momento del backup.
4. Dry-run en producción con el wrapper del paso 5, declarando explícitamente
   `DEPLOY_TARGET=vpsovhcloudilasesorias`. Leer el plan **ID por ID**.
5. Comparar esa salida contra la del paso 5. `--apply` únicamente si los IDs
   coinciden con los validados en pruebas. Si aparece un ID nuevo, algo pasó
   después del backup: cerrá sin aplicar y volvé al paso 2 con una ventana
   nueva.
6. Ejecutar el wrapper del paso 6 con
   `DEPLOY_TARGET=vpsovhcloudilasesorias`, `--apply` y la confirmación exacta.
7. Repetir las validaciones del paso 7 contra producción.
8. **Cerrar la ventana** recién con esas validaciones en verde. Desde este
   punto el rollback por restauración ya no es seguro: cualquier escritura
   posterior se perdería al revertir.

Si no se puede sostener una ventana de base completa, la reparación **no se
lleva a producción** hasta tener una: no hay forma de revertir sin descartar
trabajo ajeno, y eso convierte un incidente en dos.

La reparación es idempotente: una segunda ejecución del mismo manifiesto
encuentra `noop` y no escribe auditoría.

## Si algo sale mal

La reparación corre en una sola transacción: o entra completa con su
auditoría, o no entra. Si quedó aplicada y hay que revertirla, se restaura el
backup del paso 8.2 — no se "des-reparan" filas a mano.

Esa restauración reemplaza la base completa, así que solo es segura dentro de
la ventana de mantenimiento descrita en el paso 8: con la ventana abierta no
hay escrituras intermedias que perder. Si la ventana ya se cerró y después
aparece un problema, **no** restaures: la pérdida de las escrituras posteriores
sería peor que el defecto. En ese caso, pará, revisá la auditoría — hay un
asiento por cada efecto, con su estado previo real — y decidí una corrección
dirigida sobre esas filas.

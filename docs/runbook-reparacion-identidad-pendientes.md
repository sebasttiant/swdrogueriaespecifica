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

Verificá antes de seguir:

- El `.tar.gz` existe y su `.sha256` coincide.
- El tamaño es coherente con los backups anteriores.

Sin backup verificado, el runbook se detiene acá.

## Paso 3 — Restaurar ese backup en el VPS de pruebas

En el VPS de pruebas (`vpsovhcloudsoprotelco`), con el `.tar.gz` copiado:

```bash
bash scripts/restore-data.sh <archivo.tar.gz>
```

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
DATABASE_URL=postgresql://... AUTH_SECRET=... \
  pnpm --filter @drogueria/web db:repair:identidad -- --manifest=./repair.json
```

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
DATABASE_URL=postgresql://... AUTH_SECRET=... \
  pnpm --filter @drogueria/web db:repair:identidad -- --manifest=./repair.json --apply
```

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

Solo con el paso 7 completo y aprobado:

1. Backup fresco de producción (`scripts/backup-data.sh`), verificado.
2. Reconstruir el manifiesto **contra producción** corriendo de nuevo las
   consultas del paso 4. No se copian los IDs del manifiesto de pruebas: la
   copia restaurada y producción divergieron desde el momento del backup.
3. **Ventana sin escrituras.** Mientras la reparación corre, nadie debe estar
   capturando pendientes ni recibiendo mercadería de esos productos. La
   herramienta bloquea cada fila y aborta si algo cambió, así que una
   escritura concurrente no corrompe nada — pero sí te deja la reparación a
   medio camino y hay que empezar de nuevo.
4. Dry-run en producción. Leer el plan **ID por ID**.
5. Comparar esa salida contra la del paso 5. `--apply` únicamente si los IDs
   coinciden con los validados en pruebas. Si aparece un ID nuevo, algo pasó
   después del backup: volvé al paso 2.
6. `--apply`.
7. Repetir las validaciones del paso 7 contra producción.

La reparación es idempotente: una segunda ejecución del mismo manifiesto
encuentra `noop` y no escribe auditoría.

## Si algo sale mal

La reparación corre en una sola transacción: o entra completa con su
auditoría, o no entra. Si quedó aplicada y hay que revertirla, se restaura el
backup del paso 8.1 — no se "des-reparan" filas a mano.

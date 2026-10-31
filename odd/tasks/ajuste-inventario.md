# Ajuste de inventario auditado

Dar a Bodega una forma de corregir el stock de un lote cuando el conteo físico no coincide con el sistema, dejando constancia de quién, cuándo, cuánto y por qué.

## Specs

1. **S1** — "si hazlo  haz todo el 1 y el 2" / "continuemos con las mejoras planteadas"
2. **S2** — Propuesta aprobada (punto 2): "Hoy **no existe forma de corregir stock desde la app**: el sistema tiene preparado el movimiento `ADJUSTMENT`, pero nada lo usa. Por eso las 2 unidades fantasma de SEDATIF siguen ahí, y la próxima diferencia de conteo va a tener el mismo problema."
3. **S3** — Forma pedida: "una pantalla para Bodega o gerencia con cantidad, **motivo obligatorio** (incluido «diferencia de conteo sin causa conocida»), quién y cuándo, y auditoría."
4. **S4** — Caso real que debe resolver: las 2 unidades fantasma del producto `cmvflawai0chb01k6lmit2deu` (`MAN-8B1DC5F9`), cuya causa es desconocida. Se aceptó que "no se sabe" es un motivo honesto y auditable, en vez de inventar una causa.
5. **S5** — Restricción vigente del proyecto: "La herramienta de identidad nunca mueve ni da de baja stock" y "El stock se mueve con entradas, salidas y ajustes, que dejan un movimiento auditable. Escribir `stock = 20` a mano vuelve ficción cualquier cuadre posterior".

## Decisiones de diseño

- **Modelo vivo: `ProductBatch`.** Verificado: `inventory-entry.service.ts` escribe con `upsertBatchQuantity`, y `/productos/[id]` lee `getSellableStock` + `getBatchesByProduct`. El ledger canónico (`lots` + `inventory_movements`) existe pero **ningún flujo lo llama** (`inventory-allocation.service.ts` no tiene llamadores): el cutover no ocurrió. Un ajuste sobre `lots` no cambiaría lo que ve la droguería.
- **El ajuste es por LOTE, no por producto.** La cantidad vive en el lote; elegir cuál se corrige es parte de la decisión de quien cuenta.
- **Motivo de lista cerrada**, obligatorio, con nota opcional. Texto libre solo no sirve para agrupar ni auditar.
- **No se puede sacar mercadería prometida.** Si el lote tiene reservas de pendientes, el ajuste no puede dejar la cantidad por debajo de lo reservado.
- **Capacidad propia `canAdjustInventory`**, no reutilizar `canCreateEntries`: recibir tiene una factura detrás; ajustar es declarar que la realidad no coincide con el sistema. Roles: SUPERADMIN, ADMIN, BODEGA.
- **Sin migración de datos**: la capacidad es código y la auditoría usa la tabla existente.

## Tasks

- **T1** · S2-S5 · Servicio `adjustBatchQuantity`: transacción, lock de fila, guardas de negativo y de reservado, idempotencia y auditoría · parent · implemented (targetQuantity after lock)
- **T2** · S3 · Capacidad `canAdjustInventory`, Server Action y formulario en `/productos/[id]` · parent · implemented

## Log

- **L1** — "continuemos con las mejoras planteadas"
- **L2** — Mapa verificado del inventario: `product_batches` es el modelo vivo; el ledger canónico `lots`/`inventory_movements` tiene `computeAndApplyQuantities` con soporte de `ADJUSTMENT` (signo libre, lock, idempotencia, guarda de reservado) pero sin llamadores en producción.
- **L3** — Motivos acordados para la lista cerrada: conteo físico, merma, error de carga y causa desconocida.
- **L4** — 2026-10-31: PROBIO A31972 phantom 5→0 applied in prod via audited emergency SQL (audit cmaudfaa089a288ce448fa3da). App path (#321) continues so future adjusts are not raw SQL.
- **L5** — Service API uses `targetQuantity` (final counted qty); delta computed after FOR UPDATE lock.

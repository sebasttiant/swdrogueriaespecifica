# feature: faltantes

Lo que hay que conseguir/pedir. Estados: Faltante, Pedido, Recibido, Cancelado.

**Fase 2 (slice actual):**

- Listado de faltantes recientes en `/faltantes` (`missing-list.tsx`, server).
- Los faltantes se generan **automáticamente** desde un pendiente sin stock
  vendible suficiente (ver `features/pendientes` y
  `server/services/pending.service.ts`). `originId` enlaza al pendiente origen.

**Pendiente / fuera de scope de este slice:**

- Alta manual de faltantes (`AUDIT_ACTIONS.MISSING_CREATE` ya reservado).
- Cambios de estado y filtros.

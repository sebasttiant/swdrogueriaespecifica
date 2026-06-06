# feature: pendientes

Solicitudes de cliente. Estados: Pendiente, Parcial, Entregado, Cancelado.

**Fase 2 (slice actual):**

- Alta manual de un pendiente desde `/pendientes` (`pending-form.tsx`, client).
- Listado de pendientes recientes (`pending-list.tsx`, server).
- Regla de negocio (en `server/services/pending.service.ts`): si el stock
  vendible no alcanza, se genera un faltante por el **déficit**
  (`missingQuantity = max(requestedQuantity - sellableStock, 0)`), enlazado al
  pendiente que lo originó. No descuenta stock ni cambia estados todavía.

**Pendiente / fuera de scope de este slice:**

- Selector de producto sin búsqueda: solo la primera página de productos
  activos (cap `MAX_PAGE_SIZE`).
- Cambios de estado, filtros avanzados y entrega parcial.

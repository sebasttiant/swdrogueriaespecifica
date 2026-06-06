# feature: pendientes

Solicitudes de cliente. Estados: Pendiente, Parcial, Entregado, Cancelado.

**Fase 2 (implementado):**

- Alta manual de un pendiente desde `/pendientes` (`pending-form.tsx`, client).
- Promesa de entrega obligatoria (`promisedAt`): cuándo se le responde al cliente.
- Listado de pendientes recientes (`pending-list.tsx`, server) con **semáforo
  operativo** según la promesa (`deadline-status.ts`, función pura):
  - `Vencido`: promesa pasada y status no final.
  - `Vence pronto`: promesa dentro de las próximas 2 horas.
  - `A tiempo`: promesa futura fuera de la ventana crítica.
  - `Finalizado`: status ENTREGADO o CANCELADO.
- Regla de negocio (en `server/services/pending.service.ts`): si el stock
  vendible no alcanza, se genera un faltante por el **déficit**
  (`missingQuantity = max(requestedQuantity - sellableStock, 0)`), enlazado al
  pendiente que lo originó. Todo dentro de una transacción atómica. No descuenta
  stock ni cambia estados todavía.

**Pendiente / fuera de scope de este slice:**

- Cambios de estado, filtros avanzados y entrega parcial.
- Alertas proactivas / notificaciones sobre la promesa (solo semáforo visual).
- Selector de producto sin búsqueda: solo la primera página de productos
  activos (cap `MAX_PAGE_SIZE`).

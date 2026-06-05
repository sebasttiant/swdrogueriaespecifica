# feature: auditoria

Consulta de auditoría para líderes / admin. **Fase 1: estructura + tipos.**

Base ya disponible:

- Modelo `AuditLog` (Prisma) — ver `prisma/schema.prisma`.
- Servicio reutilizable — `server/services/audit.service.ts` (`recordAudit`).
- Acciones/módulos canónicos — `lib/constants/audit.ts`.
- Tipos de consulta/filtros — `features/auditoria/types.ts`.

En Fase 2 se construye la pantalla con filtros: fecha, usuario, acción, módulo,
entidad y resultado (exitoso/fallido).

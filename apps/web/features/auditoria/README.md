# feature: auditoria

Consulta de auditoría para líderes/admin. **Estado: lista para MVP con lectura
gerencial.**

La pantalla debe responder, sin obligar a leer códigos técnicos:

- quién hizo la acción;
- qué hizo;
- sobre qué módulo o registro;
- cuándo ocurrió;
- si fue exitosa o falló.

Base ya disponible:

- Modelo `AuditLog` (Prisma) — ver `prisma/schema.prisma`.
- Servicio reutilizable — `server/services/audit.service.ts` (`recordAudit`).
- Acciones/módulos canónicos — `lib/constants/audit.ts`.
- Tipos de consulta/filtros — `features/auditoria/types.ts`.
- Formateador de presentación — `features/auditoria/audit-format.ts`.
- Tests del formateador — `features/auditoria/audit-format.test.ts`.

## UX de negocio

La base sigue guardando códigos canónicos (`auth.login`, `user.update`, etc.),
pero la UI muestra lenguaje humano:

| Dato técnico | Vista para gerencia |
| ------------ | ------------------- |
| `auth.login` | Inicio de sesión |
| `auth.logout` | Cierre de sesión |
| `auth` | Accesos al sistema |
| `User · <id>` | Usuario del sistema + referencia secundaria |

Ejemplo de resumen por fila:

> Super Admin inició sesión.

Los IDs técnicos no son el dato principal. Si hacen falta para soporte, se
muestran como `Ref.` secundaria y discreta.

## Responsive

Auditoría mantiene el contrato mobile-first del proyecto:

- en mobile se usan tarjetas, no una tabla ancha;
- la tabla desktop queda limitada a `lg`;
- textos largos, referencias e IDs se contienen con clases seguras para evitar
  overflow horizontal;
- cualquier cambio futuro en esta pantalla debe validarse en ancho iPhone/Android.

## Roadmap local

| Estado | Tema | Nota |
| ------ | ---- | ---- |
| ✅ | Consulta con filtros | Fecha, usuario, acción, módulo y resultado. |
| ✅ | Lenguaje gerencial | Acciones, módulos, entidades y resumen por fila son legibles para negocio. |
| ✅ | Mobile seguro | Cards responsive; la tabla desktop no fuerza ancho en mobile. |
| 🔲 | Seguimiento | Validar en VPS/iPhone después de cada deploy y ajustar nuevas acciones si aparecen códigos canónicos nuevos. |

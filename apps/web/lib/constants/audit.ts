// --------------------------------------------------------------------------
// Acciones y módulos canónicos de auditoría.
// `AuditLog.action` y `AuditLog.module` son String en Prisma; estas constantes
// son la fuente de verdad tipada. Crecen por fase sin migración de base.
// --------------------------------------------------------------------------

export const AUDIT_MODULES = {
  AUTH: "auth",
  PRODUCTOS: "productos",
  PENDIENTES: "pendientes",
  FALTANTES: "faltantes",
  ENTRADAS: "entradas",
  REPORTES: "reportes",
  AUDITORIA: "auditoria",
  USUARIOS: "usuarios",
  ADMIN: "admin",
} as const;

export type AuditModule = (typeof AUDIT_MODULES)[keyof typeof AUDIT_MODULES];

export const AUDIT_ACTIONS = {
  // Auth
  LOGIN: "auth.login",
  LOGOUT: "auth.logout",
  LOGIN_FAILED: "auth.login.failed",
  // Productos
  PRODUCT_CREATE: "product.create",
  PRODUCT_UPDATE: "product.update",
  PRODUCT_DEACTIVATE: "product.deactivate",
  // Pendientes
  PENDING_CREATE: "pending.create",
  PENDING_STATUS_CHANGE: "pending.status.change",
  PENDING_DELIVERED: "pending.delivered",
  PENDING_CANCELLED: "pending.cancelled",
  // Tramo comercial: contactar al cliente y facturarle. Son transiciones
  // propias, no variantes de `PENDING_STATUS_CHANGE` (que es del eje de
  // compras): facturar es lo que habilita la entrega, así que necesita su
  // propia respuesta a quién, cuándo y por cuánto.
  PENDING_CONTACTED: "pending.contacted",
  PENDING_INVOICED: "pending.invoiced",
  // Faltantes
  MISSING_AUTO_CREATE: "missing.auto.create",
  MISSING_CREATE: "missing.create",
  MISSING_STATUS_CHANGE: "missing.status.change",
  MISSING_CONFIRM_OK: "missing.confirm.ok",
  MISSING_ITEM_ORDERED: "missing.ordered",
  // Descarte de un faltante duplicado o que ya no hace falta. Acción propia y
  // NO un alias de `MISSING_CONFIRM_OK`: descartar afirma que nadie lo va a
  // pedir, confirmar afirmaba que ya se pidió. Son hechos opuestos.
  MISSING_DISCARDED: "missing.discarded",
  MISSING_REPORT_CREATE: "missing.report.create",
  MISSING_REPORT_LINKED: "missing.report.linked",
  // Salida rápida de la cola de revisión, sin pasar por el catálogo. NO son
  // alias de `MISSING_REPORT_LINKED`: vincular genera un faltante canónico,
  // esto solo registra la decisión de gerencia sobre el reporte.
  MISSING_REPORT_ORDERED: "missing.report.ordered",
  MISSING_REPORT_DISCARDED: "missing.report.discarded",
  // La mercadería llegó y gerencia cerró el reporte a mano. Distinto de
  // `MISSING_CLOSED_BY_ENTRY`: allá lo cierra el stock, acá una persona.
  MISSING_REPORT_RECEIVED: "missing.report.received",
  // Entradas
  ENTRY_CREATE: "entry.create",
  MISSING_CLOSED_BY_ENTRY: "missing.closed.by.entry",
  // Reportes / archivos
  REPORT_EXPORT: "report.export",
  FILE_IMPORT: "file.import",
  // Usuarios (gestión por ADMIN / SUPERADMIN)
  USER_CREATE: "user.create",
  USER_UPDATE: "user.update",
  USER_ACTIVATE: "user.activate",
  USER_DEACTIVATE: "user.deactivate",
  USER_ARCHIVE: "user.archive",
  USER_RESTORE: "user.restore",
  // Admin
  ADMIN_CHANGE: "admin.change",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

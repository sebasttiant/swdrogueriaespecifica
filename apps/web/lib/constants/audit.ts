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
  // Faltantes
  MISSING_AUTO_CREATE: "missing.auto.create",
  MISSING_CREATE: "missing.create",
  MISSING_STATUS_CHANGE: "missing.status.change",
  MISSING_CONFIRM_OK: "missing.confirm.ok",
  MISSING_ITEM_ORDERED: "missing.ordered",
  MISSING_REPORT_CREATE: "missing.report.create",
  MISSING_REPORT_LINKED: "missing.report.linked",
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

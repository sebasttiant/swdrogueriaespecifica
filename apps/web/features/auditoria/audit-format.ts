// --------------------------------------------------------------------------
// Capa de presentación de auditoría (PURA, sin efectos).
// Traduce los códigos técnicos que guarda `AuditLog` a lenguaje de negocio
// para que un gerente entienda la bitácora sin leer como un desarrollador.
//
// Las llaves de los mapas son los valores REALES emitidos por `recordAudit`
// (ver `lib/constants/audit.ts` y `server/actions/*`). Cualquier código no
// contemplado cae a un humanizador seguro: nunca rompe la UI ni queda vacío.
// --------------------------------------------------------------------------

import type { AuditResultValue } from "./types";

// Códigos canónicos de acción -> etiqueta humana.
const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Inicio de sesión",
  "auth.logout": "Cierre de sesión",
  "auth.login.failed": "Intento fallido de inicio de sesión",
  "product.create": "Producto creado",
  "product.update": "Producto actualizado",
  "product.deactivate": "Producto desactivado",
  "pending.create": "Pendiente creado",
  "pending.status.change": "Cambio de estado de pendiente",
  "missing.create": "Faltante generado",
  "missing.auto.create": "Faltante generado automáticamente",
  "missing.status.change": "Cambio de estado de faltante",
  "missing.closed.by.entry": "Faltante cerrado por una entrada",
  "entry.create": "Entrada registrada",
  "report.export": "Reporte exportado",
  "file.import": "Archivo importado",
  "user.create": "Usuario creado",
  "user.update": "Usuario actualizado",
  "user.activate": "Usuario activado",
  "user.deactivate": "Usuario desactivado",
  "user.archive": "Usuario archivado",
  "user.restore": "Usuario restaurado",
  "admin.change": "Cambio administrativo",
};

// Módulos canónicos -> nombre de negocio.
const MODULE_LABELS: Record<string, string> = {
  auth: "Accesos al sistema",
  productos: "Productos",
  usuarios: "Usuarios",
  pendientes: "Pendientes",
  entradas: "Entradas",
  faltantes: "Faltantes",
  reportes: "Reportes",
  auditoria: "Auditoría",
  admin: "Administración",
};

// Tipo de entidad técnico -> sustantivo legible para negocio.
const ENTITY_LABELS: Record<string, string> = {
  User: "Usuario del sistema",
  Product: "Producto",
  Pending: "Pendiente",
  MissingItem: "Faltante",
  InventoryEntry: "Entrada de inventario",
};

// Frase en pasado (sin punto) por acción, para narrar "quién hizo qué".
// No incluye el calificador de éxito/fracaso: lo agrega buildAuditSummary.
const ACTION_PHRASES: Record<string, string> = {
  "auth.login": "inició sesión",
  "auth.logout": "cerró sesión",
  "auth.login.failed": "intentó iniciar sesión",
  "product.create": "creó un producto",
  "product.update": "actualizó un producto",
  "product.deactivate": "desactivó un producto",
  "pending.create": "creó un pendiente",
  "pending.status.change": "cambió el estado de un pendiente",
  "missing.create": "generó un faltante",
  "missing.auto.create": "generó un faltante automáticamente",
  "missing.status.change": "cambió el estado de un faltante",
  "missing.closed.by.entry": "cerró un faltante con una entrada",
  "entry.create": "registró una entrada",
  "report.export": "exportó un reporte",
  "file.import": "importó un archivo",
  "user.create": "creó un usuario",
  "user.update": "actualizó un usuario",
  "user.activate": "activó un usuario",
  "user.deactivate": "desactivó un usuario",
  "user.archive": "archivó un usuario",
  "user.restore": "restauró un usuario",
  "admin.change": "realizó un cambio administrativo",
};

// Convierte un código técnico ("inventory.bulk_adjust") en algo legible
// ("Inventory bulk adjust"). Devuelve "" si no queda contenido aprovechable.
function humanizeCode(raw: string): string {
  const cleaned = raw.replace(/[._]+/g, " ").trim().replace(/\s+/g, " ");
  if (cleaned.length === 0) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function formatAuditAction(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  const fallback = humanizeCode(action);
  return fallback.length > 0 ? fallback : "Acción desconocida";
}

export function formatAuditModule(module: string): string {
  const known = MODULE_LABELS[module];
  if (known) return known;
  const fallback = humanizeCode(module);
  return fallback.length > 0 ? fallback : "Módulo desconocido";
}

export type AuditEntityView = {
  // Sustantivo legible — información PRINCIPAL en la UI.
  label: string;
  // ID técnico — referencia SECUNDARIA y discreta. null si no aplica.
  reference: string | null;
};

export function formatAuditEntity(
  entity: string,
  entityId: string | null,
): AuditEntityView {
  const label = ENTITY_LABELS[entity] ?? "Registro relacionado";
  const reference = entityId && entityId.length > 0 ? entityId : null;
  return { label, reference };
}

export type AuditSummaryInput = {
  actor: string;
  action: string;
  result: AuditResultValue;
};

export function buildAuditSummary({
  actor,
  action,
  result,
}: AuditSummaryInput): string {
  const phrase =
    ACTION_PHRASES[action] ??
    `realizó la acción "${formatAuditAction(action)}"`;
  const suffix = result === "SUCCESS" ? "" : " sin éxito";
  return `${actor} ${phrase}${suffix}.`;
}

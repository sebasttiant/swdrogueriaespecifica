import type { AuditAction, AuditModule } from "@/lib/constants/audit";

export type AuditResultValue = "SUCCESS" | "FAILURE";

// Vista de una entrada de auditoría (lista para la UI de Fase 2).
export type AuditLogView = {
  id: string;
  userId: string | null;
  action: string;
  module: string;
  entity: string;
  entityId: string | null;
  result: AuditResultValue;
  ip: string | null;
  userAgent: string | null;
  channel: string | null;
  createdAt: string; // ISO 8601
};

// Filtros de consulta de auditoría (líderes / admin).
export type AuditFilters = {
  from?: string; // ISO date
  to?: string; // ISO date
  userId?: string;
  action?: AuditAction | string;
  module?: AuditModule | string;
  entity?: string;
  result?: AuditResultValue;
};

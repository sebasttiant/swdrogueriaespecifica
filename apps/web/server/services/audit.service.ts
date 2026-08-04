import { headers } from "next/headers";

import type { AuditAction, AuditModule } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { Paginated } from "@/lib/pagination";
import {
  listAuditLogs,
  type AuditListParams,
  type AuditLogListItem,
} from "@/server/repositories/audit.repository";

// --------------------------------------------------------------------------
// Servicio de auditoría reutilizable (server-only).
//
// Responde, para cada acción importante del sistema:
//   quién · cuándo · qué · sobre qué registro · qué cambió · desde dónde ·
//   si fue exitoso o fallido.
//
// En Fase 1 el servicio está listo para usarse; las acciones de negocio que lo
// invocan se implementan por fase (ver `lib/constants/audit.ts`).
// --------------------------------------------------------------------------

// Boundary de LECTURA para la UI de auditoría. La página delega acá y nunca
// toca el repositorio directo (mismo patrón que pendientes/faltantes).
export function getAuditLogs(
  params: AuditListParams,
): Promise<Paginated<AuditLogListItem>> {
  return listAuditLogs(params);
}

export type AuditContext = {
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  channel?: string | null;
};

export type RecordAuditInput = {
  action: AuditAction | string;
  module: AuditModule | string;
  entity: string;
  entityId?: string | null;
  result?: "SUCCESS" | "FAILURE";
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  context?: AuditContext;
  correlationId?: string | null;
};

export type AuditWriteResult =
  | { ok: true }
  | { ok: false; errorClass: string; errorCode: string | null };

function sanitizedError(error: unknown): Omit<Extract<AuditWriteResult, { ok: false }>, "ok"> {
  if (typeof error !== "object" || error === null) {
    return { errorClass: "UnknownError", errorCode: null };
  }
  const candidate = error as { name?: unknown; code?: unknown };
  return {
    errorClass: typeof candidate.name === "string" ? candidate.name : "Error",
    errorCode: typeof candidate.code === "string" ? candidate.code : null,
  };
}

/**
 * Registra una entrada de auditoría.
 *
 * No relanza errores: una falla al auditar NO debe romper la operación de
 * negocio. Si el log falla, se reporta por consola para no perder la señal.
 */
export async function recordAudit(input: RecordAuditInput): Promise<AuditWriteResult> {
  const { context } = input;

  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        module: input.module,
        entity: input.entity,
        entityId: input.entityId ?? null,
        result: input.result ?? "SUCCESS",
        before: input.before,
        after: input.after,
        userId: context?.userId ?? null,
        ip: context?.ip ?? null,
        userAgent: context?.userAgent ?? null,
        channel: context?.channel ?? null,
      },
    });
    return { ok: true };
  } catch (error) {
    const sanitized = sanitizedError(error);
    console.error("[audit] write_failed", {
      correlationId: input.correlationId ?? null,
      ...sanitized,
    });
    return { ok: false, ...sanitized };
  }
}

/**
 * Construye el AuditContext desde los headers de la request actual.
 * Server-only (usa next/headers). Reutilizable por cualquier Server Action.
 */
export async function auditContextFromHeaders(
  userId?: string | null,
): Promise<AuditContext> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    userId: userId ?? null,
    ip: forwarded ?? h.get("x-real-ip") ?? null,
    userAgent: h.get("user-agent") ?? null,
    channel: "web",
  };
}

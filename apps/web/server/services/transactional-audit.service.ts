import type { Prisma } from "@/lib/generated/prisma/client";
import type { RecordAuditInput } from "@/server/services/audit.service";

// --------------------------------------------------------------------------
// Auditoría TRANSACCIONAL (server-only).
//
// Es el opuesto deliberado de `recordAudit`: escribe con el cliente de la
// transacción en curso y NO atrapa el error. Si la auditoría falla, la
// operación de negocio se revierte entera.
//
// Por qué existen las dos formas: para la mayor parte del sistema, perder una
// línea de auditoría es mejor que voltearle la operación al operador, y por eso
// `recordAudit` es tolerante a propósito. Pero en el alta de IDENTIDAD de
// producto la regla se invierte: un producto acuñado sin rastro es un producto
// que después nadie puede explicar, y de esa identidad cuelga todo el
// inventario. Decisión del dueño, acotada a este flujo: los demás llamadores de
// `recordAudit` siguen con el comportamiento tolerante.
// --------------------------------------------------------------------------

export type TransactionalAuditWriter = (
  client: Prisma.TransactionClient,
  input: RecordAuditInput,
) => Promise<void>;

export const recordAuditInTransaction: TransactionalAuditWriter = async (
  client,
  input,
) => {
  await client.auditLog.create({
    data: {
      action: input.action,
      module: input.module,
      entity: input.entity,
      entityId: input.entityId ?? null,
      result: input.result ?? "SUCCESS",
      before: input.before,
      after: input.after,
      userId: input.context?.userId ?? null,
      ip: input.context?.ip ?? null,
      userAgent: input.context?.userAgent ?? null,
      channel: input.context?.channel ?? null,
    },
  });
};

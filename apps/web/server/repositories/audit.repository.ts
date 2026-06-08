// --------------------------------------------------------------------------
// Repositorio de auditoría (LECTURA) — ÚNICO lugar que lee `AuditLog` vía
// Prisma. La escritura vive en `audit.service.ts` (recordAudit). Listado
// SIEMPRE paginado (cursor-based), más recientes primero. Trae el usuario
// responsable para que la UI muestre quién hizo cada acción sin un query extra.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import {
  clampTake,
  decodeCursor,
  encodeCursor,
  type Paginated,
} from "@/lib/pagination";
import type { AuditResult } from "@/lib/generated/prisma/client";

export type AuditLogListItem = {
  id: string;
  action: string;
  module: string;
  entity: string;
  entityId: string | null;
  result: AuditResult;
  createdAt: Date;
  user: { id: string; name: string; email: string } | null;
};

const LIST_SELECT = {
  id: true,
  action: true,
  module: true,
  entity: true,
  entityId: true,
  result: true,
  createdAt: true,
  user: { select: { id: true, name: true, email: true } },
} as const;

export async function listAuditLogs(params: {
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<AuditLogListItem>> {
  const take = clampTake(params.take);
  let cursorId = params.cursor ? decodeCursor(params.cursor) : null;

  // El cursor es input controlado por el usuario. `decodeCursor` ya descarta la
  // basura (round-trip), pero un cursor bien formado puede apuntar a un id que
  // no existe (registro borrado o cursor inventado). Validamos su existencia con
  // un lookup barato por PK: si no existe, lo ignoramos y servimos la primera
  // página. Así un cursor inutilizable nunca rompe la consulta de paginación.
  if (cursorId) {
    const exists = await prisma.auditLog.findUnique({
      where: { id: cursorId },
      select: { id: true },
    });
    if (!exists) cursorId = null;
  }

  // take + 1 para detectar página siguiente sin un count extra.
  const rows = await prisma.auditLog.findMany({
    take: take + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: LIST_SELECT,
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.id) : null;

  return { items, nextCursor };
}

// --------------------------------------------------------------------------
// Repositorio de auditoría (LECTURA) — ÚNICO lugar que lee `AuditLog` vía
// Prisma. La escritura vive en `audit.service.ts` (recordAudit). Listado
// SIEMPRE paginado (cursor-based), más recientes primero. Trae el usuario
// responsable para que la UI muestre quién hizo cada acción sin un query extra.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import { bogotaDayToUtcRange } from "@/lib/datetime/bogota-date-range";
import {
  clampTake,
  decodeCursor,
  encodeCursor,
  type Paginated,
} from "@/lib/pagination";
import type { AuditResult, Prisma } from "@/lib/generated/prisma/client";

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

// Filtros aceptados por listAuditLogs. Los campos string se tratan como exacto;
// userText es free-text que hace ILIKE en name+email del usuario relacionado
// (JOIN — no usa el índice [userId], aceptable a escala MVP).
export type AuditListParams = {
  cursor?: string | null;
  take?: number;
  action?: string;
  module?: string;
  entity?: string;
  result?: "SUCCESS" | "FAILURE";
  // Free-text search sobre user.name y user.email (OR, case-insensitive).
  userText?: string;
  // Fechas de calendario YYYY-MM-DD interpretadas en America/Bogota.
  from?: string;
  to?: string;
};

export async function listAuditLogs(
  params: AuditListParams,
): Promise<Paginated<AuditLogListItem>> {
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

  // Construimos el where combinado (AND implícito).
  const where = buildWhere(params);

  // take + 1 para detectar página siguiente sin un count extra.
  const rows = await prisma.auditLog.findMany({
    take: take + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    ...(where ? { where } : {}),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: LIST_SELECT,
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.id) : null;

  return { items, nextCursor };
}

// --------------------------------------------------------------------------
// Construcción del where
// --------------------------------------------------------------------------

function buildWhere(
  params: AuditListParams,
): Prisma.AuditLogWhereInput | undefined {
  const clause: Prisma.AuditLogWhereInput = {};
  let hasAny = false;

  // Exact-match filters
  const action = params.action?.trim();
  if (action) {
    clause.action = action;
    hasAny = true;
  }

  const moduleVal = params.module?.trim();
  if (moduleVal) {
    clause.module = moduleVal;
    hasAny = true;
  }

  const entity = params.entity?.trim();
  if (entity) {
    clause.entity = entity;
    hasAny = true;
  }

  if (params.result) {
    clause.result = params.result;
    hasAny = true;
  }

  // Free-text user search (name OR email ILIKE).
  // NOTE: This is a JOIN filter — does not use the [userId] index. Acceptable
  // at MVP scale; revisit if the table grows large and this query becomes slow.
  const userText = params.userText?.trim();
  if (userText) {
    clause.user = {
      OR: [
        { name: { contains: userText, mode: "insensitive" } },
        { email: { contains: userText, mode: "insensitive" } },
      ],
    };
    hasAny = true;
  }

  // Date range (YYYY-MM-DD → UTC boundaries via Bogota timezone).
  const { from, to } = bogotaDayToUtcRange({
    from: params.from,
    to: params.to,
  });

  if (from !== undefined || to !== undefined) {
    const createdAt: Prisma.DateTimeFilter<"AuditLog"> = {};
    if (from !== undefined) createdAt.gte = from;
    if (to !== undefined) createdAt.lt = to;
    clause.createdAt = createdAt;
    hasAny = true;
  }

  return hasAny ? clause : undefined;
}

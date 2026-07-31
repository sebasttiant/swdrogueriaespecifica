// --------------------------------------------------------------------------
// Repositorio de entradas de inventario — ÚNICO lugar que toca Prisma para
// `InventoryEntry`. Ledger de recepciones: quién recibió, cuánto, cuándo.
// Escritura solo desde el service (dentro de $transaction).
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import {
  clampTake,
  decodeCursor,
  encodeCursor,
  type Paginated,
} from "@/lib/pagination";
import type { Prisma } from "@/lib/generated/prisma/client";

export type InventoryEntryListItem = {
  id: string;
  quantity: number;
  note: string | null;
  createdAt: Date;
  product: { name: string; code: string };
  createdBy: { name: string | null } | null;
};

export type CreateInventoryEntryData = {
  productId: string;
  quantity: number;
  note?: string;
  createdById?: string | null;
  idempotencyKey?: string;
  requestFingerprint?: string;
};

const LIST_SELECT = {
  id: true,
  quantity: true,
  note: true,
  createdAt: true,
  product: { select: { name: true, code: true } },
  createdBy: { select: { name: true } },
} as const;

// Escritura atómica — acepta tx client para vivir dentro del $transaction del service.
export async function createInventoryEntry(
  client: Prisma.TransactionClient,
  data: CreateInventoryEntryData,
) {
  return client.inventoryEntry.create({
    data: {
      productId: data.productId,
      quantity: data.quantity,
      note: data.note ?? null,
      createdById: data.createdById ?? null,
      idempotencyKey: data.idempotencyKey ?? crypto.randomUUID(),
      requestFingerprint: data.requestFingerprint ?? "legacy",
    },
  });
}

export function findInventoryEntryByIdempotencyKey(
  client: Prisma.TransactionClient,
  idempotencyKey: string,
) {
  return client.inventoryEntry.findUnique({
    where: { idempotencyKey },
    select: { id: true, requestFingerprint: true },
  });
}

// Listado paginado por cursor — siempre del más reciente al más antiguo.
export async function listInventoryEntries(params: {
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<InventoryEntryListItem>> {
  const take = clampTake(params.take);
  const cursorId = params.cursor ? decodeCursor(params.cursor) : null;

  const rows = await prisma.inventoryEntry.findMany({
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

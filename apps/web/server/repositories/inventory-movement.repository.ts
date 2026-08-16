// --------------------------------------------------------------------------
// Ledger de movimientos — ÚNICO lugar que toca Prisma para
// `InventoryMovement`.
//
// La API es deliberadamente incompleta: hay `append` y hay lecturas, y NO hay
// update ni delete. No es un olvido. Un asiento contable no se corrige
// editándolo: se corrige asentando un movimiento de ajuste, que deja las dos
// versiones de la historia visibles. La base además lo protege con RESTRICT en
// las claves foráneas.
//
// El ledger guarda el HECHO BRUTO. No calcula saldos ni valida que el stock
// alcance: las ecuaciones de conservación llegan con T1.4, y quién puede
// mover qué lo deciden los comandos de cada flujo.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type {
  InventoryMovement,
  InventoryMovementType,
  Prisma,
} from "@/lib/generated/prisma/client";
import { clampTake, decodeCursor, encodeCursor, type Paginated } from "@/lib/pagination";

export type AppendMovementData = {
  lotId: string;
  /** Denormalizado del lote al asentar: queda congelado con el hecho. */
  productId: string;
  type: InventoryMovementType;
  /** Delta firmado: positivo agrega, negativo resta. */
  quantity: number;
  actorId: string;
  /** Todo movimiento nace de un comando: cero cambios sin rastro. */
  commandId: string;
  occurredAt?: Date;
};

/**
 * La ÚNICA escritura del ledger. Un INSERT y nada más.
 *
 * `client` permite asentarlo dentro de la transacción del comando, que es como
 * tiene que usarse: si el efecto falla, no queda ni el comando ni el asiento.
 */
export function appendMovement(
  data: AppendMovementData,
  client: Prisma.TransactionClient = prisma,
): Promise<InventoryMovement> {
  if (!Number.isInteger(data.quantity)) {
    throw new RangeError(`quantity must be an integer, received ${data.quantity}`);
  }

  return client.inventoryMovement.create({
    data: {
      lotId: data.lotId,
      productId: data.productId,
      type: data.type,
      quantity: data.quantity,
      actorId: data.actorId,
      commandId: data.commandId,
      ...(data.occurredAt ? { occurredAt: data.occurredAt } : {}),
    },
  });
}

export function findMovementById(
  id: string,
  client: Prisma.TransactionClient = prisma,
): Promise<InventoryMovement | null> {
  return client.inventoryMovement.findUnique({ where: { id } });
}

type PageParams = {
  cursor?: string | null;
  take?: number;
};

// Paginación por id descendente: el ledger solo crece, así que un cursor por id
// da una foto estable —lo que ya se leyó no se mueve— sin un `count` extra.
async function paginate(
  where: Prisma.InventoryMovementWhereInput,
  params: PageParams,
  client: Prisma.TransactionClient,
): Promise<Paginated<InventoryMovement>> {
  const take = clampTake(params.take);
  const cursorId = params.cursor ? decodeCursor(params.cursor) : null;

  const rows = await client.inventoryMovement.findMany({
    take: take + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    where,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const last = items.at(-1);

  return { items, nextCursor: hasMore && last ? encodeCursor(last.id) : null };
}

export function listMovementsByLot(
  lotId: string,
  params: PageParams = {},
  client: Prisma.TransactionClient = prisma,
): Promise<Paginated<InventoryMovement>> {
  return paginate({ lotId }, params, client);
}

export function listMovementsByProduct(
  productId: string,
  params: PageParams & { type?: InventoryMovementType } = {},
  client: Prisma.TransactionClient = prisma,
): Promise<Paginated<InventoryMovement>> {
  return paginate(
    { productId, ...(params.type ? { type: params.type } : {}) },
    params,
    client,
  );
}

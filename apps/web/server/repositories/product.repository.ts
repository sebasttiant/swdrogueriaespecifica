// --------------------------------------------------------------------------
// Repositorio de productos — ÚNICO lugar que toca Prisma para `Product`.
// Listado SIEMPRE paginado (cursor-based). Nunca un findMany sin `take`.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import {
  clampTake,
  decodeCursor,
  encodeCursor,
  type Paginated,
} from "@/lib/pagination";
import type { Prisma, Product } from "@/lib/generated/prisma/client";

export type ProductListItem = Pick<
  Product,
  | "id"
  | "code"
  | "name"
  | "unit"
  | "minStock"
  | "reorderQty"
  | "active"
  | "createdAt"
  // Identidad canónica. Viaja en el listado porque quien elige un producto para
  // un pendiente necesita cotejarlo contra Orion, y el `code` interno no existe
  // del otro lado.
  | "orionCode"
> & {
  // Earliest expiry among batches with quantity > 0. Null if no active batches.
  // Used to compute per-product worst expiry tier in the catalog list (S3).
  worstExpiresAt: Date | null;
  // El laboratorio del catálogo. Desempata cuando dos productos se llaman
  // parecido, que es exactamente lo que hizo elegir el equivocado al registrar
  // una entrada. `null` mientras nadie se lo asignó.
  laboratory: { name: string } | null;
};

export type CreateProductData = {
  code: string;
  name: string;
  unit: string;
  minStock: number;
  reorderQty: number;
  // Producto creado al vuelo desde un pendiente manual: queda marcado para que
  // un ADMIN lo revise. Ausente/false para las altas normales del catálogo.
  needsReview?: boolean;
  // Código de Orion en el INSERT, no en un update posterior. Un producto que
  // nace con su identidad nunca existe —ni por un instante— sin ella, así que
  // no hay ventana en la que otro proceso lo vea sin código y se lo asigne.
  orionCode?: string | null;
  // Laboratorio asociado al producto (opcional).
  laboratoryId?: string | null;
};

// Include the batch with the earliest expiry (quantity > 0) per product.
// Prisma does not support aggregate subqueries in select, so we include up to
// one batch ordered by expiresAt asc — the first result is the worst tier.
// This avoids N+1: one query per page, not one per product row.
const LIST_SELECT = {
  id: true,
  code: true,
  orionCode: true,
  name: true,
  unit: true,
  minStock: true,
  reorderQty: true,
  active: true,
  createdAt: true,
  // El laboratorio desempata cuando dos productos se llaman parecido. Sin él,
  // la lista de entradas obliga a elegir entre nombres casi idénticos.
  laboratory: { select: { name: true } },
  batches: {
    where: { quantity: { gt: 0 } },
    select: { expiresAt: true },
    orderBy: { expiresAt: "asc" as const },
    take: 1,
  },
} as const;

export async function listProducts(params: {
  cursor?: string | null;
  take?: number;
  q?: string;
  active?: boolean;
}): Promise<Paginated<ProductListItem>> {
  const take = clampTake(params.take);
  const cursorId = params.cursor ? decodeCursor(params.cursor) : null;
  const search = params.q?.trim() || undefined;

  const where =
    search || params.active !== undefined
      ? {
          ...(params.active !== undefined ? { active: params.active } : {}),
          ...(search
            ? {
                OR: [
                  { name: { contains: search, mode: "insensitive" as const } },
                  { code: { contains: search, mode: "insensitive" as const } },
                ],
              }
            : {}),
        }
      : undefined;

  // Pedimos take + 1 para saber si hay página siguiente sin un count extra.
  const rows = await prisma.product.findMany({
    take: take + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    ...(where ? { where } : {}),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: LIST_SELECT,
  });

  const hasMore = rows.length > take;
  const rawItems = hasMore ? rows.slice(0, take) : rows;
  const last = rawItems.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.id) : null;

  // Map raw rows → ProductListItem: flatten worst batch expiry to a scalar.
  const items: ProductListItem[] = rawItems.map((row) => {
    const { batches, ...rest } = row;
    return {
      ...rest,
      worstExpiresAt: batches[0]?.expiresAt ?? null,
    };
  });

  return { items, nextCursor };
}

export async function findProductById(id: string): Promise<Product | null> {
  return prisma.product.findUnique({ where: { id } });
}

// `client` permite crear el producto dentro de una transacción (ej. el alta
// atómica de un pendiente manual); por defecto usa el singleton.
export async function createProduct(
  data: CreateProductData,
  client: Prisma.TransactionClient = prisma,
): Promise<Product> {
  return client.product.create({ data });
}

/** Los campos de catálogo que la edición puede tocar. Nada de cantidades. */
export type UpdateProductData = {
  code: string;
  name: string;
  unit: string;
  minStock: number;
  reorderQty: number;
  laboratoryId: string | null;
  active: boolean;
};

/**
 * Actualiza los datos de CATÁLOGO de un producto.
 *
 * El tipo es la garantía: `UpdateProductData` no tiene `orionCode`, ni
 * `internalSku`, ni `identityVersion`, ni ninguna cantidad. Un llamador no
 * puede colar por acá un cambio de identidad ni un stock escrito a mano,
 * aunque lo intente — no compila.
 */
export async function updateProduct(
  id: string,
  data: UpdateProductData,
  client: Prisma.TransactionClient = prisma,
): Promise<Product> {
  return client.product.update({ where: { id }, data });
}

/**
 * Actualiza SOLO si el producto sigue como se leyó. Devuelve `null` si no.
 *
 * `updatedAt` alcanza como testigo y evita una columna nueva: Prisma lo mueve
 * en cada escritura (`@updatedAt`), así que si alguien guardó en el medio, el
 * `where` no encuentra la fila y el `count` vuelve en 0.
 *
 * Va con `updateMany` a propósito: `update` con un `where` compuesto tiraría, y
 * lo que hace falta acá es DISTINGUIR "no coincide" de "explotó" para poder
 * decirle a la persona que alguien más lo cambió.
 */
export async function updateProductIfUnchanged(
  id: string,
  expectedUpdatedAt: Date,
  data: UpdateProductData,
  client: Prisma.TransactionClient = prisma,
): Promise<Product | null> {
  const { count } = await client.product.updateMany({
    where: { id, updatedAt: expectedUpdatedAt },
    data,
  });
  if (count === 0) return null;
  return client.product.findUnique({ where: { id } });
}

export async function upsertProvisionalProduct(
  client: Prisma.TransactionClient,
  data: { normalizedName: string; displayName: string },
): Promise<Product> {
  return client.product.upsert({
    where: { provisionalNormalizedName: data.normalizedName },
    update: {},
    create: {
      code: `PROV-${data.normalizedName}`,
      name: data.displayName.trim(),
      unit: "unidad",
      minStock: 0,
      reorderQty: 0,
      needsReview: true,
      provisionalNormalizedName: data.normalizedName,
    },
  });
}

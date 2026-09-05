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
// Módulo PURO (sin Prisma ni reloj): la presentación tiene una sola
// definición y su fallback vive ahí, no copiado acá.
import { MANUAL_UNIT_FALLBACK } from "@/features/pendientes/presentation";

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
  // Los DOS contadores que protegen al producto. Viajan al listado porque la
  // pantalla que deja elegir un producto es la que despues tiene que declarar
  // contra que fotografia se escribio: sin ellos, quien registra una entrada no
  // puede decir que fue lo que vio.
  | "identityVersion"
  | "catalogVersion"
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
  identityVersion: true,
  catalogVersion: true,
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

/**
 * La fotografia AUTORITATIVA del producto para registrar una entrada.
 *
 * Es lo que la fila dice, no lo que el formulario mando.
 */
export type EntryProductSnapshot = {
  id: string;
  name: string;
  orionCode: string | null;
  /** `unit` es la PRESENTACION: frasco, sobre, caja, blister, ampolla. */
  unit: string;
  identityVersion: number;
  catalogVersion: number;
};

/**
 * Bloquea la fila del producto y devuelve su estado autoritativo.
 *
 * `FOR UPDATE` es lo que hace que la comparacion de versiones signifique algo.
 * Sin el lock quedaria una ventana entre leer la version y escribir el lote: en
 * ese hueco alguien edita el producto, la comprobacion ya paso, y la entrada se
 * registra contra una identidad que dejo de existir. Con el lock, una edicion
 * simultanea espera a que esta transaccion termine, y esta transaccion ve un
 * valor que no puede cambiar debajo suyo.
 *
 * DEBE llamarse dentro de una transaccion, y DESPUES de resolver el
 * laboratorio: `editProduct` toma `laboratories` y luego `products`, asi que
 * tomarlos al reves aca cruzaria las esperas y PostgreSQL matarial una de las
 * dos con 40P01. El orden es unico para todo el sistema.
 */
export async function lockProductForEntry(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<EntryProductSnapshot | null> {
  const rows = await tx.$queryRaw<EntryProductSnapshot[]>`
    SELECT id, name, "orionCode", unit, "identityVersion", "catalogVersion"
    FROM products WHERE id = ${id} FOR UPDATE
  `;
  return rows[0] ?? null;
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
 * Actualiza SOLO si nadie tocó el catálogo desde que se leyó. Devuelve `null`
 * si alguien llegó antes.
 *
 * El testigo es `catalogVersion`, un ENTERO, y no `updatedAt`. Una marca de
 * tiempo dice cuándo pasó algo, no en qué orden: `TIMESTAMP(3)` tiene
 * resolución de milisegundo y PostgreSQL no promete que dos escrituras rápidas
 * caigan en milisegundos distintos. Con fechas iguales, un control basado en
 * compararlas concluye que nada cambió y deja pasar la escritura que debía
 * rechazar.
 *
 * El incremento va en la MISMA sentencia que la escritura que protege, así que
 * no hay ventana entre comprobar y avanzar.
 *
 * Va con `updateMany` a propósito: `update` con un `where` compuesto tiraría, y
 * acá hace falta DISTINGUIR "no coincide la versión" de "explotó" para poder
 * decirle a la persona que alguien más lo cambió.
 */
export async function updateProductIfVersionMatches(
  id: string,
  expectedVersion: number,
  data: UpdateProductData,
  client: Prisma.TransactionClient = prisma,
): Promise<Product | null> {
  const { count } = await client.product.updateMany({
    where: { id, catalogVersion: expectedVersion },
    data: { ...data, catalogVersion: { increment: 1 } },
  });
  if (count === 0) return null;
  return client.product.findUnique({ where: { id } });
}

/**
 * El producto provisional de un reporte de faltante.
 *
 * `update: {}` NO es un descuido: si el producto ya existe, este camino no le
 * toca NADA. La presentación que informa un vendedor solo se usa al CREARLO.
 * Pisar la del catálogo desde una pantalla de captura sería dejar que un
 * reporte rápido reescriba información compartida —y `presentation.ts` es
 * explícito en que ninguna pantalla que no sea de captura la edita—.
 */
export async function upsertProvisionalProduct(
  client: Prisma.TransactionClient,
  data: { normalizedName: string; displayName: string; presentation?: string },
): Promise<Product> {
  return client.product.upsert({
    where: { provisionalNormalizedName: data.normalizedName },
    update: {},
    create: {
      code: `PROV-${data.normalizedName}`,
      name: data.displayName.trim(),
      // Sin presentación informada cae en el mismo valor de siempre, que
      // `presentation.ts` ya sabe leer como "sin presentación".
      unit: data.presentation ?? MANUAL_UNIT_FALLBACK,
      minStock: 0,
      reorderQty: 0,
      needsReview: true,
      provisionalNormalizedName: data.normalizedName,
    },
  });
}

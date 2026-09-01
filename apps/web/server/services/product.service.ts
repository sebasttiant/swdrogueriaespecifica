// --------------------------------------------------------------------------
// Servicio de productos (server-only). Boundary de negocio: la página/acción
// delega acá y nunca toca el repositorio directo. Hoy es fino; crece con las
// reglas.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { Paginated } from "@/lib/pagination";
import { findOrCreateLaboratory } from "@/server/repositories/laboratory.repository";
import { laboratoryCreateCommandKey } from "@/server/domain/laboratory/identity";
import type { Product } from "@/lib/generated/prisma/client";
import {
  createProduct,
  updateProduct,
  updateProductIfVersionMatches,
  type UpdateProductData,
  findProductById,
  listProducts,
  type CreateProductData,
  type ProductListItem,
} from "@/server/repositories/product.repository";

export function getProducts(params: {
  cursor?: string | null;
  take?: number;
  q?: string;
  active?: boolean;
}): Promise<Paginated<ProductListItem>> {
  return listProducts(params);
}

export type ActiveProductOption = Pick<ProductListItem, "id" | "name" | "code">;

export async function getActiveProductsForMissingItem(params: {
  cursor?: string | null;
  q: string;
}): Promise<Paginated<ActiveProductOption>> {
  const page = await getProducts({
    active: true,
    q: params.q,
    take: 20,
    ...(params.cursor ? { cursor: params.cursor } : {}),
  });

  return {
    items: page.items
      .filter((product) => product.active)
      .map(({ id, name, code }) => ({ id, name, code })),
    nextCursor: page.nextCursor,
  };
}

export function getProduct(id: string): Promise<Product | null> {
  return findProductById(id);
}

export function addProduct(data: CreateProductData): Promise<Product> {
  return createProduct(data);
}

/**
 * Edita los datos de catálogo de un producto y devuelve el ANTES y el DESPUÉS.
 *
 * Devuelve los dos a propósito: quien audita necesita saber qué cambió, no
 * solo cómo quedó. "El laboratorio ahora es Genfar" no dice nada; "era Bayer y
 * ahora es Genfar" es lo que permite entender una decisión seis meses después.
 *
 * Devuelve `null` si el producto no existe, en vez de tirar: para la acción es
 * un 404, no un error del sistema.
 */
/** Qué pasó al intentar guardar. La pantalla necesita distinguirlos. */
export type EditProductResult =
  | { status: "saved"; before: Product; after: Product }
  | { status: "not_found" }
  /** Alguien más guardó el producto entre que se abrió el formulario y ahora. */
  | { status: "stale" }
  /** El nombre escrito no resolvió a un laboratorio propio. */
  | { status: "laboratory_unresolved"; name: string };

export type EditProductInput = UpdateProductData & {
  /** El texto que quedó escrito en el buscador, si no se eligió de la lista. */
  laboratoryName?: string;
  /**
   * La versión de catálogo que el formulario le MOSTRÓ a la persona.
   *
   * Entero, no fecha: ver `updateProductIfVersionMatches`.
   */
  expectedVersion: number;
  /** Quién edita: entra en la clave del comando al crear un laboratorio. */
  actorId: string;
};

/**
 * Edita los datos de catálogo de un producto y devuelve el ANTES y el DESPUÉS.
 *
 * Devuelve los dos a propósito: quien audita necesita saber qué cambió, no
 * solo cómo quedó. "El laboratorio ahora es Genfar" no dice nada; "era Bayer y
 * ahora es Genfar" es lo que permite entender una decisión seis meses después.
 *
 * Todo ocurre en UNA transacción: si el laboratorio se crea pero el producto no
 * se puede guardar —porque alguien lo cambió en el medio—, no queda un
 * laboratorio suelto que nadie pidió.
 */
/**
 * Aborta la transacción llevándose el desenlace puesto.
 *
 * Prisma CONFIRMA la transacción cuando el callback devuelve normalmente, así
 * que un `return { status: "stale" }` desde adentro dejaba escrito el
 * laboratorio recién creado aunque el producto no se hubiera guardado: un
 * laboratorio huérfano que nadie pidió. La única forma de deshacer es TIRAR.
 */
class EditProductAbort extends Error {
  constructor(readonly result: EditProductResult) {
    super("edit product aborted");
    this.name = "EditProductAbort";
  }
}

export async function editProduct(
  id: string,
  input: EditProductInput,
): Promise<EditProductResult> {
  const { laboratoryName, expectedVersion, actorId, ...data } = input;

  try {
    return await prisma.$transaction(async (tx) => {
    const before = await tx.product.findUnique({ where: { id } });
      if (!before) throw new EditProductAbort({ status: "not_found" });

    // El buscador suelta la selección en cuanto alguien escribe algo distinto
    // de lo elegido: manda el id vacío y el nombre tipeado. Ignorar ese texto
    // convertía "escribí Genfar y guardé" en "quitá el laboratorio", con la
    // pantalla mostrando Genfar. Se resuelve como en Entradas: por identidad
    // canónica, creándolo si no existe.
    let laboratoryId = data.laboratoryId;
    const typed = laboratoryName?.trim();
    if (!laboratoryId && typed) {
      const resolved = await findOrCreateLaboratory(
        { name: typed, commandKey: laboratoryCreateCommandKey("manual", actorId, typed) },
        tx,
      );
      // `exact_name_exists` significa que volvió OTRO laboratorio: pegarle ese
      // al producto sería atribuirle una marca que nadie escribió, que es
      // justamente lo que la identidad canónica existe para impedir.
      if (resolved.status === "exact_name_exists") {
          throw new EditProductAbort({ status: "laboratory_unresolved", name: typed });
      }
      laboratoryId = resolved.laboratory.id;
    }

    const after = await updateProductIfVersionMatches(
      id,
      expectedVersion,
      { ...data, laboratoryId },
      tx,
    );
    // Sin fila actualizada, alguien guardó en el medio. No se pisa: se avisa.
      if (!after) throw new EditProductAbort({ status: "stale" });

      return { status: "saved", before, after } as const;
    });
  } catch (error) {
    // El desenlace viaja dentro del error justamente para poder abortar: la
    // transacción se deshizo y con ella cualquier laboratorio a medio crear.
    if (error instanceof EditProductAbort) return error.result;
    throw error;
  }
}

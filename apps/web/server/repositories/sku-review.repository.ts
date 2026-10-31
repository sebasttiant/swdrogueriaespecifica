// --------------------------------------------------------------------------
// Repositorio de identidad de producto — ÚNICO lugar que toca Prisma para
// acuñar un SKU interno y para vincular el código Orion.
//
// Las reglas viven en `server/domain/catalog/sku-identity.ts`; acá solo se
// ejecutan contra la base. Dos cosas que este archivo garantiza y que no se
// pueden probar sin PostgreSQL de verdad:
//
//  - La colisión de SKU la detecta el índice único de la base, no una consulta
//    previa: entre el `SELECT` y el `INSERT` puede meterse otro escritor.
//  - El vínculo con el código Orion usa compare-and-set sobre la versión de
//    identidad, así dos operadores simultáneos no se pisan.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { Prisma, Product } from "@/lib/generated/prisma/client";
import { orionCodeVariants } from "@/server/domain/catalog/orion-code";
import {
  assertAttemptWithinBudget,
  generateUlid,
  provisionalSkuFor,
  resolveIdentityMode,
  SkuIdentityError,
  type IdentityInput,
  type OrionLinkPlan,
} from "@/server/domain/catalog/sku-identity";

/** Perdió la carrera: otro escritor cambió la identidad primero. */
export class SkuConcurrencyError extends Error {
  constructor() {
    super("identity version did not match the expected one");
    this.name = "SkuConcurrencyError";
  }
}

const ULID_RANDOM_BYTES = 10;

// Reloj y azar inyectables: la prueba fuerza colisiones repitiendo el mismo
// ULID, que es la única forma honesta de ejercitar el presupuesto de reintentos.
export type SkuGenerationDeps = {
  now?: () => number;
  randomness?: () => Uint8Array;
};

function defaultRandomness(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(ULID_RANDOM_BYTES));
}

/**
 * Violación de índice único (P2002).
 *
 * A propósito NO se mira QUÉ índice falló: con Prisma 7 y el adapter de `pg`,
 * `meta.target` no existe y los campos quedan en una forma interna del adapter
 * (`meta.driverAdapterError.cause.constraint.fields`). Colgar una decisión de
 * negocio de esa estructura es atarse a un detalle no documentado que puede
 * cambiar en cualquier versión. Quien necesite distinguir qué índice fue, que
 * lo averigüe consultando la base.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export type CreateProvisionalProductData = {
  name: string;
  unit: string;
  minStock?: number;
  reorderQty?: number;
};

/** Rastro del comando que acuñó la identidad, cuando el alta viene de uno. */
export type IdentityCommand = {
  key: string;
  fingerprint: string;
};

/**
 * UN intento de alta con el SKU ya acuñado. Es una sola sentencia: o entra
 * completa, o no entra.
 *
 * Existe aparte del reintento porque en PostgreSQL una violación de índice
 * único ABORTA la transacción: quien necesite auditar en la misma transacción
 * tiene que abrir una nueva por cada intento, y para eso necesita ejecutar los
 * intentos de a uno.
 */
export async function insertProvisionalProduct(
  client: Prisma.TransactionClient,
  data: CreateProvisionalProductData & { internalSku: string; command?: IdentityCommand },
): Promise<Product> {
  return client.product.create({
    data: {
      // El código interno heredado y el SKU nuevo son el mismo valor: no se
      // inventa un segundo esquema de códigos para el mismo producto.
      code: data.internalSku,
      internalSku: data.internalSku,
      name: data.name.trim(),
      unit: data.unit,
      minStock: data.minStock ?? 0,
      reorderQty: data.reorderQty ?? 0,
      skuStatus: "PROVISIONAL_REVIEW",
      needsReview: true,
      identityCommandKey: data.command?.key ?? null,
      identityCommandFingerprint: data.command?.fingerprint ?? null,
    },
  });
}

/** Acuña el SKU del próximo intento. */
export function mintInternalSku(deps: SkuGenerationDeps = {}): string {
  const now = deps.now ?? Date.now;
  const randomness = deps.randomness ?? defaultRandomness;
  return provisionalSkuFor(generateUlid(now(), randomness()));
}

export function findProductByIdentityCommandKey(
  key: string,
  client: Prisma.TransactionClient = prisma,
): Promise<Product | null> {
  return client.product.findUnique({ where: { identityCommandKey: key } });
}

/**
 * Acuña un SKU interno y crea el producto marcado para revisión.
 *
 * Si el índice único rechaza el SKU, reintenta con otro dentro del presupuesto
 * aprobado. Agotado el presupuesto el error es terminal y NO queda ninguna
 * fila a medio crear: cada intento es un `INSERT` completo o nada.
 */
export async function createProvisionalProduct(
  data: CreateProvisionalProductData,
  deps: SkuGenerationDeps = {},
  client: Prisma.TransactionClient = prisma,
): Promise<Product> {
  for (let attempt = 1; ; attempt += 1) {
    assertAttemptWithinBudget(attempt);

    try {
      return await insertProvisionalProduct(client, {
        ...data,
        internalSku: mintInternalSku(deps),
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // SKU tomado: el siguiente intento acuña otro.
    }
  }
}

/**
 * Busca por identidad EXACTA. `resolveIdentityMode` es quien decide cuál de las
 * tres claves se usa —y quien rechaza un nombre—, así que por acá no entra una
 * búsqueda difusa ni por error.
 */
export async function findProductByIdentity(
  input: IdentityInput,
  client: Prisma.TransactionClient = prisma,
): Promise<Product | null> {
  const identity = resolveIdentityMode(input);

  switch (identity.mode) {
    case "PRODUCT_ID":
      return client.product.findUnique({ where: { id: identity.value } });
    case "INTERNAL_SKU":
      return client.product.findUnique({ where: { internalSku: identity.value } });
    case "ORION_CODE": {
      // Primero la forma canónica exacta (post-renombre). Si no está, el
      // histórico todavía puede tener otra grafía del MISMO número —y WINDOW 1
      // tiene que encontrarla ANTES de renombrar, o tipear `20956` deja de
      // ver `a-20956`.
      const exact = await client.product.findUnique({
        where: { orionCode: identity.value },
      });
      if (exact) return exact;

      const variants = orionCodeVariants(identity.value).filter((variant) => variant !== "");
      if (variants.length === 0) return null;

      const sharing = await client.product.findMany({
        where: {
          OR: variants.map((variant) => ({
            orionCode: { equals: variant, mode: "insensitive" as const },
          })),
        },
        // Dos alcanza: singular vs “hay copias”. Si hay varias, esta API no
        // elige — el llamador usa `findProductsSharingOrionIdentity`.
        take: 2,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return sharing.length === 1 ? sharing[0]! : null;
    }
  }
}

/** Lo que la pantalla necesita para que una persona elija entre copias. */
export type OrionIdentityCandidate = Pick<
  Product,
  "id" | "code" | "name" | "orionCode" | "unit" | "active"
>;

/**
 * Los productos que YA tienen este número de Orión, sin importar cómo se
 * escribió el código.
 *
 * Es deliberadamente una función APARTE de `findProductByIdentity`, que sigue
 * siendo exacta. La diferencia no es técnica, es de responsabilidad:
 *
 *   exacta   responde "¿quién tiene EXACTAMENTE este código?" y de su
 *            respuesta cuelga el vínculo de identidad, que escribe sola.
 *   por número  responde "¿quiénes podrían ser el mismo producto?" y su
 *            respuesta SIEMPRE termina en una persona eligiendo.
 *
 * Mientras el histórico siga sin normalizar, un mismo número puede devolver
 * varias filas —hubo hasta CINCO del mismo producto—. Por eso devuelve una
 * lista: que el sistema eligiera una por su cuenta es exactamente el error que
 * esto viene a cerrar.
 *
 * Se resuelve con una consulta normal de Prisma, no con SQL crudo: las formas
 * en que un número pudo escribirse son pocas y enumerables
 * (`orionCodeVariants`), así que no hace falta recortar prefijos dentro de la
 * base. Sale tipado, usa el índice y no hay una sola cadena interpolada.
 */
export async function findProductsSharingOrionIdentity(
  rawCode: string,
  options: { excludeProductId?: string } = {},
  client: Prisma.TransactionClient = prisma,
): Promise<OrionIdentityCandidate[]> {
  const variants = orionCodeVariants(rawCode).filter((variant) => variant !== "");
  if (variants.length === 0) return [];

  return client.product.findMany({
    where: {
      // `insensitive` cubre `a-20956` y `sku20956` sin listarlos aparte.
      OR: variants.map((variant) => ({
        orionCode: { equals: variant, mode: "insensitive" as const },
      })),
      ...(options.excludeProductId ? { id: { not: options.excludeProductId } } : {}),
    },
    select: {
      id: true,
      code: true,
      name: true,
      orionCode: true,
      unit: true,
      active: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export type ApplyOrionLinkOptions = {
  /** Versión de identidad que el llamador OBSERVÓ en el producto destino. */
  expectedVersion: number;
  /** Ídem para el producto que hoy tiene el código, cuando se lo muda. */
  holderExpectedVersion?: number;
};

/**
 * Ejecuta el plan de vínculo con compare-and-set.
 *
 * El remapeo libera el código del producto anterior y lo asigna al nuevo en UNA
 * transacción: si algo falla en el medio, el código no queda en el aire.
 *
 * `client` permite ejecutarlo dentro de una transacción que abrió el llamador
 * —el servicio lo necesita para que la auditoría entre en la MISMA transacción
 * que el vínculo—. Sin él, abre la suya.
 */
export async function applyOrionLink(
  plan: OrionLinkPlan,
  options: ApplyOrionLinkOptions,
  client?: Prisma.TransactionClient,
): Promise<Product> {
  if (client) return runOrionLinkPlan(client, plan, options);
  return prisma.$transaction((tx) => runOrionLinkPlan(tx, plan, options));
}

async function runOrionLinkPlan(
  tx: Prisma.TransactionClient,
  plan: OrionLinkPlan,
  options: ApplyOrionLinkOptions,
): Promise<Product> {
  if (plan.action === "NOOP") {
    // Idempotente: sin escritura y sin avanzar la versión.
    const product = await tx.product.findUnique({ where: { id: plan.productId } });
    if (!product) throw new SkuConcurrencyError();
    return product;
  }

  if (plan.action === "RELINK") {
    await releaseOrionCode(tx, {
      productId: plan.releasedFromProductId,
      orionCode: plan.orionCode,
      expectedVersion: options.holderExpectedVersion,
    });
  }

  if (plan.action === "FIX") {
    return fixOrionCode(tx, {
      productId: plan.productId,
      orionCode: plan.orionCode,
      previousOrionCode: plan.previousOrionCode,
      expectedVersion: options.expectedVersion,
    });
  }

  return assignOrionCode(tx, {
    productId: plan.productId,
    orionCode: plan.orionCode,
    expectedVersion: options.expectedVersion,
  });
}

/**
 * Reemplaza un código mal cargado por el correcto.
 *
 * Se separa de `assignOrionCode` por el filtro, que es lo único que importa
 * acá: aquel exige `orionCode: null` —su segunda red contra pisar identidad—
 * y este exige el código ANTERIOR exacto. Es la misma idea aplicada al revés:
 * la corrección solo escribe si el código sigue siendo el que se vio en
 * pantalla. Si cambió en el medio, `count` da 0 y nadie pisa nada.
 */
async function fixOrionCode(
  tx: Prisma.TransactionClient,
  params: {
    productId: string;
    orionCode: string;
    previousOrionCode: string;
    expectedVersion: number;
  },
): Promise<Product> {
  const { count } = await tx.product
    .updateMany({
      where: {
        id: params.productId,
        identityVersion: params.expectedVersion,
        orionCode: params.previousOrionCode,
      },
      data: {
        orionCode: params.orionCode,
        skuStatus: "CONFIRMED",
        identityVersion: { increment: 1 },
      },
    })
    .catch((error: unknown) => {
      // Mismo caso que en el alta: la lectura previa vio el código libre y otro
      // lo tomó antes de que llegara esta escritura. Lo frena el `@unique`.
      if (isUniqueViolation(error)) throw new SkuIdentityError("ORION_CONFLICT");
      throw error;
    });

  if (count !== 1) throw new SkuConcurrencyError();

  const product = await tx.product.findUnique({ where: { id: params.productId } });
  if (!product) throw new SkuConcurrencyError();
  return product;
}

async function releaseOrionCode(
  tx: Prisma.TransactionClient,
  params: { productId: string; orionCode: string; expectedVersion?: number },
): Promise<void> {
  const { count } = await tx.product.updateMany({
    where: {
      id: params.productId,
      orionCode: params.orionCode,
      ...(params.expectedVersion === undefined
        ? {}
        : { identityVersion: params.expectedVersion }),
    },
    data: { orionCode: null, identityVersion: { increment: 1 } },
  });

  if (count !== 1) throw new SkuConcurrencyError();
}

async function assignOrionCode(
  tx: Prisma.TransactionClient,
  params: { productId: string; orionCode: string; expectedVersion: number },
): Promise<Product> {
  // El compare-and-set mira SOLO esta fila, así que es incapaz de ver que otro
  // producto se quedó con el mismo código. Ese caso lo frena el `@unique` de la
  // base y llega hasta acá como P2002.
  //
  // Pasa cuando dos operadores vinculan el mismo código a productos distintos
  // al mismo tiempo: `linkOrionCode` lee al holder FUERA de la transacción, así
  // que los dos leen "no lo tiene nadie" y los dos planean LINK.
  //
  // Sin traducirlo, ese P2002 escapa crudo y termina en el mensaje genérico
  // "intentá de nuevo" — el peor consejo posible, porque reintentar eso no va a
  // funcionar nunca. Es justo el conflicto que `ORION_CONFLICT` ya sabe nombrar.
  const { count } = await tx.product
    .updateMany({
      // El `orionCode: null` del filtro es la segunda red: aunque alguien haya
      // avanzado la versión sin tocar el código, no se pisa una identidad puesta.
      where: {
        id: params.productId,
        identityVersion: params.expectedVersion,
        orionCode: null,
      },
      data: {
        orionCode: params.orionCode,
        skuStatus: "CONFIRMED",
        identityVersion: { increment: 1 },
      },
    })
    .catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new SkuIdentityError("ORION_CONFLICT");
      throw error;
    });

  if (count !== 1) throw new SkuConcurrencyError();

  const product = await tx.product.findUnique({ where: { id: params.productId } });
  if (!product) throw new SkuConcurrencyError();
  return product;
}

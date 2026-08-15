// --------------------------------------------------------------------------
// Repositorio de identidad de producto — ÚNICO lugar que toca Prisma para
// acuñar un SKU interno y para buscar un producto por identidad exacta.
//
// Las reglas viven en `server/domain/catalog/sku-identity.ts`; acá solo se
// ejecutan contra la base. Lo que este archivo garantiza y no se puede probar
// sin PostgreSQL de verdad: la colisión de SKU la detecta el índice único de
// la base, no una consulta previa. Entre un `SELECT` y un `INSERT` puede
// meterse otro escritor, y entonces el que pierde es el índice quien lo dice.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { Prisma, Product } from "@/lib/generated/prisma/client";
import {
  assertAttemptWithinBudget,
  generateUlid,
  provisionalSkuFor,
  resolveIdentityMode,
  type IdentityInput,
} from "@/server/domain/catalog/sku-identity";

const ULID_RANDOM_BYTES = 10;

// Reloj y azar inyectables: la prueba fuerza colisiones repitiendo el mismo
// instante y los mismos bytes, que es la única forma honesta de ejercitar el
// presupuesto de reintentos contra la base real.
export type SkuGenerationDeps = {
  now?: () => number;
  randomness?: () => Uint8Array;
};

function defaultRandomness(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(ULID_RANDOM_BYTES));
}

function isUniqueViolation(error: unknown): boolean {
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

/**
 * Acuña un SKU interno y crea el producto marcado para revisión.
 *
 * Si el índice único rechaza el SKU, reintenta con otro dentro del presupuesto
 * aprobado. Agotado el presupuesto el error es terminal y NO queda ninguna fila
 * a medio crear: cada intento es un `INSERT` completo, o nada.
 */
export async function createProvisionalProduct(
  data: CreateProvisionalProductData,
  deps: SkuGenerationDeps = {},
  client: Prisma.TransactionClient = prisma,
): Promise<Product> {
  const now = deps.now ?? Date.now;
  const randomness = deps.randomness ?? defaultRandomness;

  for (let attempt = 1; ; attempt += 1) {
    assertAttemptWithinBudget(attempt);

    const internalSku = provisionalSkuFor(generateUlid(now(), randomness()));

    try {
      return await client.product.create({
        data: {
          // El código interno heredado y el SKU nuevo son el mismo valor: no se
          // inventa un segundo esquema de códigos para el mismo producto.
          code: internalSku,
          internalSku,
          name: data.name.trim(),
          unit: data.unit,
          minStock: data.minStock ?? 0,
          reorderQty: data.reorderQty ?? 0,
          skuStatus: "PROVISIONAL_REVIEW",
          needsReview: true,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // SKU tomado: el intento siguiente acuña otro.
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
    case "ORION_CODE":
      return client.product.findUnique({ where: { orionCode: identity.value } });
  }
}

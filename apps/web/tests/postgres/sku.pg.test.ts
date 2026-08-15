import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  PROVISIONAL_SKU_PREFIX,
  SKU_COLLISION_MAX_ATTEMPTS,
  SkuIdentityError,
} from "@/server/domain/catalog/sku-identity";
import {
  createProvisionalProduct,
  findProductByIdentity,
  type SkuGenerationDeps,
} from "@/server/repositories/sku-review.repository";

// Estas pruebas corren contra PostgreSQL de verdad (harness de T0.2): la
// unicidad del SKU la decide el índice de la base, y eso no se puede simular
// con un doble de prueba sin dejar de probar justamente lo que importa.

const created: string[] = [];

async function newProvisional(name: string, deps?: SkuGenerationDeps) {
  const product = await createProvisionalProduct({ name, unit: "unidad" }, deps);
  created.push(product.id);
  return product;
}

/** Aleatoriedad fija: repite bytes para forzar el mismo ULID. */
function fixedRandomness(...sequence: number[][]): () => Uint8Array {
  let call = 0;
  return () => {
    const bytes = sequence[Math.min(call, sequence.length - 1)];
    call += 1;
    return new Uint8Array(bytes as number[]);
  };
}

// El ULID lleva el instante adelante: para provocar una colisión hay que fijar
// el reloj Y la aleatoriedad. Cada caso usa su propio instante para no chocar
// con los productos de otro.
function frozenClock(offsetMinutes: number): () => number {
  const at = new Date("2026-08-15T00:00:00Z").getTime() + offsetMinutes * 60_000;
  return () => at;
}

const BYTES_A = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const BYTES_B = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];

afterEach(async () => {
  if (created.length === 0) return;
  await prisma.product.deleteMany({ where: { id: { in: created } } });
  created.length = 0;
});

describe("createProvisionalProduct", () => {
  it("persiste el producto con SKU acuñado y marcado para revisión", async () => {
    const product = await newProvisional("Ibuprofeno 400mg");

    expect(product.internalSku?.startsWith(PROVISIONAL_SKU_PREFIX)).toBe(true);
    expect(product.skuStatus).toBe("PROVISIONAL_REVIEW");
    expect(product.orionCode).toBeNull();
    expect(product.identityVersion).toBe(0);
    // El código interno heredado y el SKU nuevo son el mismo valor: no se
    // inventa un segundo esquema de códigos para el mismo producto.
    expect(product.code).toBe(product.internalSku);
  });

  it("dos altas seguidas reciben SKU distintos", async () => {
    const first = await newProvisional("Amoxicilina 500mg");
    const second = await newProvisional("Amoxicilina 500mg");

    expect(first.internalSku).not.toBe(second.internalSku);
  });

  // El nombre no deduplica: dos productos con el mismo nombre son dos
  // productos, cada uno con su identidad.
  it("no deduplica por nombre", async () => {
    const first = await newProvisional("Dipirona");
    const second = await newProvisional("Dipirona");

    expect(first.id).not.toBe(second.id);
  });

  it("reintenta cuando el SKU acuñado ya existe y termina creando uno solo", async () => {
    const now = frozenClock(1);
    const first = await newProvisional("Loratadina", {
      now,
      randomness: fixedRandomness(BYTES_A),
    });

    // El primer intento repite exactamente el SKU de `first`; el segundo ya es
    // otro, y ese es el que queda.
    const second = await newProvisional("Loratadina", {
      now,
      randomness: fixedRandomness(BYTES_A, BYTES_B),
    });

    expect(second.internalSku).not.toBe(first.internalSku);
  });

  // Presupuesto D2: agotados los cinco intentos, error terminal y NINGUNA fila
  // a medio crear.
  it("agota el presupuesto sin dejar el producto a medio crear", async () => {
    const now = frozenClock(2);
    const taken = await newProvisional("Cetirizina", {
      now,
      randomness: fixedRandomness(BYTES_A),
    });
    const before = await prisma.product.count();

    const failure = await newProvisional("Cetirizina", {
      now,
      randomness: fixedRandomness(BYTES_A),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SkuIdentityError);
    expect((failure as SkuIdentityError).code).toBe("GENERATION_EXHAUSTED");
    expect(await prisma.product.count()).toBe(before);
    // El que sí existía queda intacto.
    expect(await findProductByIdentity({ internalSku: taken.internalSku })).not.toBeNull();
  });

  it("gasta exactamente los intentos del presupuesto y ni uno más", async () => {
    const now = frozenClock(3);
    await newProvisional("Naproxeno", { now, randomness: fixedRandomness(BYTES_A) });
    let attempts = 0;

    await newProvisional("Naproxeno", {
      now,
      randomness: () => {
        attempts += 1;
        return new Uint8Array(BYTES_A);
      },
    }).catch(() => undefined);

    expect(attempts).toBe(SKU_COLLISION_MAX_ATTEMPTS);
  });
});

describe("findProductByIdentity", () => {
  it("encuentra por SKU interno y por id", async () => {
    const product = await newProvisional("Omeprazol");

    expect((await findProductByIdentity({ internalSku: product.internalSku }))?.id).toBe(
      product.id,
    );
    expect((await findProductByIdentity({ productId: product.id }))?.id).toBe(product.id);
  });

  it("devuelve null cuando la identidad no existe", async () => {
    expect(
      await findProductByIdentity({ internalSku: "PRV-0000000000000000000000" }),
    ).toBeNull();
  });

  // La regla del slice llega hasta la base: por acá no entra una búsqueda por
  // nombre ni con la mejor intención.
  it("se niega a buscar por nombre", async () => {
    await newProvisional("Paracetamol");

    const failure = await findProductByIdentity({ name: "Paracetamol" }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SkuIdentityError);
    expect((failure as SkuIdentityError).code).toBe("MISSING_EXACT_IDENTITY");
  });
});

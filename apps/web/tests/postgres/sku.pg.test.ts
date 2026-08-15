import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  planOrionLink,
  PROVISIONAL_SKU_PREFIX,
  SKU_COLLISION_MAX_ATTEMPTS,
  SkuIdentityError,
} from "@/server/domain/catalog/sku-identity";
import {
  applyOrionLink,
  createProvisionalProduct,
  findProductByIdentity,
  SkuConcurrencyError,
  type SkuGenerationDeps,
} from "@/server/repositories/sku-review.repository";

// Estas pruebas corren contra PostgreSQL de verdad (harness de T0.2): la
// unicidad, el compare-and-set y las carreras entre dos escritores no existen
// contra un doble de prueba.

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

describe("applyOrionLink", () => {
  it("vincula el código Orion y avanza la versión de identidad", async () => {
    const product = await newProvisional("Ranitidina");
    const plan = planOrionLink({
      product,
      orionCode: "7702001234567",
      holder: null,
      intent: "LINK",
    });

    const linked = await applyOrionLink(plan, {
      expectedVersion: product.identityVersion,
    });

    expect(linked.orionCode).toBe("7702001234567");
    expect(linked.identityVersion).toBe(product.identityVersion + 1);
    expect(linked.skuStatus).toBe("CONFIRMED");
  });

  // Concurrencia optimista: quien viene con una versión vieja perdió, y no pisa
  // lo que ya escribió el otro.
  it("rechaza la escritura con una versión de identidad vieja", async () => {
    const product = await newProvisional("Metformina");
    const plan = planOrionLink({
      product,
      orionCode: "7702009999999",
      holder: null,
      intent: "LINK",
    });
    await applyOrionLink(plan, { expectedVersion: product.identityVersion });

    const stale = await applyOrionLink(plan, {
      expectedVersion: product.identityVersion,
    }).catch((error: unknown) => error);

    expect(stale).toBeInstanceOf(SkuConcurrencyError);
  });

  // Dos operadores vinculando el mismo producto al mismo tiempo: esto es lo que
  // ningún doble de prueba puede decirte.
  it("con dos escritores simultáneos gana exactamente uno", async () => {
    const product = await newProvisional("Losartán");
    const plan = planOrionLink({
      product,
      orionCode: "7702005555555",
      holder: null,
      intent: "LINK",
    });

    const results = await Promise.allSettled([
      applyOrionLink(plan, { expectedVersion: product.identityVersion }),
      applyOrionLink(plan, { expectedVersion: product.identityVersion }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const after = await findProductByIdentity({ productId: product.id });
    expect(after?.identityVersion).toBe(product.identityVersion + 1);
  });

  // Mudar el código es UNA transacción: o se libera del anterior y se asigna al
  // nuevo, o no pasa nada. El código nunca queda en el aire.
  it("muda el código de un producto a otro sin dejar estados intermedios", async () => {
    const holder = await newProvisional("Enalapril viejo");
    const target = await newProvisional("Enalapril nuevo");
    const linked = await applyOrionLink(
      planOrionLink({
        product: holder,
        orionCode: "7702007777777",
        holder: null,
        intent: "LINK",
      }),
      { expectedVersion: holder.identityVersion },
    );

    const relinked = await applyOrionLink(
      planOrionLink({
        product: target,
        orionCode: "7702007777777",
        holder: linked,
        intent: "RELINK",
      }),
      {
        expectedVersion: target.identityVersion,
        holderExpectedVersion: linked.identityVersion,
      },
    );

    expect(relinked.orionCode).toBe("7702007777777");
    expect((await findProductByIdentity({ productId: holder.id }))?.orionCode).toBeNull();
  });

  it("no hace ninguna escritura cuando el plan es idempotente", async () => {
    const product = await newProvisional("Atorvastatina");
    const linked = await applyOrionLink(
      planOrionLink({
        product,
        orionCode: "7702003333333",
        holder: null,
        intent: "LINK",
      }),
      { expectedVersion: product.identityVersion },
    );

    const again = await applyOrionLink(
      planOrionLink({
        product: linked,
        orionCode: "7702003333333",
        holder: linked,
        intent: "LINK",
      }),
      { expectedVersion: linked.identityVersion },
    );

    expect(again.identityVersion).toBe(linked.identityVersion);
  });
});

import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  ManualProductIdentityConflictError,
  registerPending,
} from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// S2b · 1e-A — el producto manual nace CON su código de Orion.
//
// Contra PostgreSQL real y no contra un doble, porque lo que se prueba acá es
// justamente la restricción única de `orionCode`: un mock la daría por buena.
// --------------------------------------------------------------------------

let actorId = "";
let sequence = 0;
const stamp = Date.now();
const createdNames: string[] = [];

beforeAll(async () => {
  const actor = await prisma.user.create({
    data: { email: `manual-identity-${stamp}@test.local`, name: "Manual identity actor" },
  });
  actorId = actor.id;
});

afterEach(async () => {
  const products = await prisma.product.findMany({
    where: { name: { in: createdNames } },
    select: { id: true },
  });
  const ids = products.map((product) => product.id);
  await prisma.missingItem.deleteMany({ where: { productId: { in: ids } } });
  await prisma.pending.deleteMany({ where: { productId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
  createdNames.length = 0;
});

function manualName(suffix: string): string {
  const name = `Manual identity ${stamp} ${suffix}`;
  createdNames.push(name);
  return name;
}

function manualCapture(params: { name: string; orionCode?: string }) {
  sequence += 1;
  return {
    createdById: actorId,
    quantity: sequence,
    idempotencyKey: randomUUID(),
    promisedAt: new Date("2030-01-01T00:00:00.000Z"),
    manual: { name: params.name, unit: "unidad", orionCode: params.orionCode },
  };
}

describe("registerPending · identidad del producto manual", () => {
  it("crea el producto YA con el código: no lo escribe un update posterior", async () => {
    const name = manualName("coded");
    const orionCode = `ORN-MAN-${stamp}-1`;

    const result = await registerPending(manualCapture({ name, orionCode }));

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: result.pending.productId },
    });
    expect(product.name).toBe(name);
    expect(product.orionCode).toBe(orionCode);
    // Marcado para revisión igual que cualquier manual: tener código de Orion
    // no lo convierte en un producto de catálogo curado.
    expect(product.needsReview).toBe(true);

    // La prueba de que el código viajó en el INSERT y no en un UPDATE: el
    // producto nunca existió sin él, así que su versión de identidad sigue
    // siendo la inicial. Un update posterior la habría movido.
    expect(product.identityVersion).toBe(0);
  });

  it("sigue permitiendo un producto manual SIN código cuando se aplaza", async () => {
    const name = manualName("deferred");

    const result = await registerPending({
      ...manualCapture({ name }),
      identitySkippedReason: "ORION_UNAVAILABLE" as const,
      identitySkippedNote: "Orion no responde",
    });

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: result.pending.productId },
    });
    expect(product.orionCode).toBeNull();

    const pending = await prisma.pending.findUniqueOrThrow({
      where: { id: result.pending.id },
    });
    expect(pending.identitySkippedReason).toBe("ORION_UNAVAILABLE");
    expect(pending.identitySkippedNote).toBe("Orion no responde");
  });

  it("rechaza un código que ya es de otro producto SIN moverlo ni crear nada", async () => {
    const ownerName = manualName("owner");
    const orionCode = `ORN-MAN-${stamp}-2`;
    const owner = await prisma.product.create({
      data: { code: `OWN-${stamp}`, name: ownerName, unit: "unidad", orionCode },
    });

    const intruderName = manualName("intruder");
    await expect(
      registerPending(manualCapture({ name: intruderName, orionCode })),
    ).rejects.toBeInstanceOf(ManualProductIdentityConflictError);

    // El código NO se movió: sigue siendo del dueño original.
    const reloaded = await prisma.product.findUniqueOrThrow({ where: { id: owner.id } });
    expect(reloaded.orionCode).toBe(orionCode);
    // Y el intruso no quedó a medio crear: la transacción revirtió entera.
    expect(await prisma.product.count({ where: { name: intruderName } })).toBe(0);
  });

  it("el conflicto nombra al producto dueño, para poder ofrecer la salida", async () => {
    const ownerName = manualName("named owner");
    const orionCode = `ORN-MAN-${stamp}-3`;
    const owner = await prisma.product.create({
      data: { code: `OWN2-${stamp}`, name: ownerName, unit: "unidad", orionCode },
    });

    const error = await registerPending(
      manualCapture({ name: manualName("blocked"), orionCode }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManualProductIdentityConflictError);
    expect((error as ManualProductIdentityConflictError).holder).toEqual({
      id: owner.id,
      name: ownerName,
    });
  });

  it("un reintento exacto no crea un segundo producto ni un segundo pendiente", async () => {
    const name = manualName("retry");
    const input = manualCapture({ name, orionCode: `ORN-MAN-${stamp}-4` });

    const first = await registerPending(input);
    const second = await registerPending(input);

    expect(second.pending.id).toBe(first.pending.id);
    expect(second.replayed).toBe(true);
    expect(await prisma.product.count({ where: { name } })).toBe(1);
    expect(await prisma.pending.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(1);
  });
});

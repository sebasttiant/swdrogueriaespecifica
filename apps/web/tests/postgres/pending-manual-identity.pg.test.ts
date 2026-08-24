import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
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
  const pendings = await prisma.pending.findMany({
    where: { productId: { in: ids } },
    select: { id: true },
  });
  // Las filas de auditoría también: este archivo escribe DOS clases —el
  // vínculo del producto y el aplazamiento del pendiente— y dejarlas atrás
  // ensucia las cuentas absolutas que otros archivos hacen sobre `audit_logs`.
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { entity: "Product", entityId: { in: ids } },
        { entity: "Pending", entityId: { in: pendings.map((p) => p.id) } },
      ],
    },
  });
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

  it("deja el producto CONFIRMADO y el vínculo auditado, como cualquier otra escritura de identidad", async () => {
    const name = manualName("audited");
    const orionCode = `ORN-MAN-${stamp}-5`;

    const result = await registerPending(manualCapture({ name, orionCode }));

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: result.pending.productId },
    });
    // Un producto con código y sin estado sería un tercer estado que ni
    // PROVISIONAL_REVIEW ni CONFIRMED cubren, y la cola de revisión se lee
    // justamente por este campo.
    expect(product.skuStatus).toBe("CONFIRMED");

    // Quién ató ese código, cuándo y por qué camino. El mismo código entrando
    // por `linkOrionCodeAtCapture` deja rastro; entrando por acá no dejaba
    // ninguno, y el día que el código resulte equivocado no habría a quién
    // preguntarle.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        action: AUDIT_ACTIONS.SKU_ORION_LINK,
        entity: "Product",
        entityId: product.id,
      },
    });
    expect(audit).toMatchObject({
      module: AUDIT_MODULES.PRODUCTOS,
      userId: actorId,
      after: { orionCode, identityVersion: 0 },
    });
  });

  it("rechaza código y aplazamiento juntos: el aplazamiento diría que no se pudo obtener el que sí vino", async () => {
    const name = manualName("contradictory");

    await expect(
      registerPending({
        ...manualCapture({ name, orionCode: `ORN-MAN-${stamp}-6` }),
        identitySkippedReason: "ORION_UNAVAILABLE" as const,
      }),
    ).rejects.toThrow();

    expect(await prisma.product.count({ where: { name } })).toBe(0);
  });

  it("un código en blanco es ausencia, no un código: jamás ocupa el índice único", async () => {
    const first = manualName("blank one");
    const second = manualName("blank two");

    const a = await registerPending(manualCapture({ name: first, orionCode: "   " }));
    const b = await registerPending(manualCapture({ name: second, orionCode: "" }));

    // Si el vacío se guardara, el primero ocuparía la ranura del índice y el
    // segundo chocaría contra un P2002 sin dueño que reportar: un fallo
    // genérico irrecuperable, para siempre.
    for (const created of [a, b]) {
      const product = await prisma.product.findUniqueOrThrow({
        where: { id: created.pending.productId },
      });
      expect(product.orionCode).toBeNull();
      expect(product.skuStatus).toBeNull();
    }
  });

  it("rechaza un código con espacios internos en vez de guardarlo tal cual", async () => {
    const name = manualName("spaced");

    await expect(
      registerPending(manualCapture({ name, orionCode: "ORN 123" })),
    ).rejects.toThrow();

    expect(await prisma.product.count({ where: { name } })).toBe(0);
  });

  it("el conflicto tampoco deja el pendiente a medio crear", async () => {
    const orionCode = `ORN-MAN-${stamp}-7`;
    await prisma.product.create({
      data: { code: `OWN3-${stamp}`, name: manualName("owner3"), unit: "unidad", orionCode },
    });

    const input = manualCapture({ name: manualName("half"), orionCode });
    await expect(registerPending(input)).rejects.toBeInstanceOf(
      ManualProductIdentityConflictError,
    );

    expect(
      await prisma.pending.count({ where: { idempotencyKey: input.idempotencyKey } }),
    ).toBe(0);
  });

  it("un reintento que solo difiere en espacios sobrantes sigue siendo el mismo intento", async () => {
    const name = manualName("padded retry");
    const input = manualCapture({ name, orionCode: `ORN-MAN-${stamp}-8` });

    const first = await registerPending(input);
    const second = await registerPending({
      ...input,
      manual: { ...input.manual, orionCode: `  ${input.manual.orionCode}  ` },
    });

    // El código canónico es el mismo, así que esto es el MISMO intento. Tratar
    // un espacio pegado de más como "otros datos" le negaría el reintento a
    // quien solo volvió a pegar el código.
    expect(second.pending.id).toBe(first.pending.id);
    expect(second.replayed).toBe(true);
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

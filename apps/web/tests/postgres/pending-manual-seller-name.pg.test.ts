import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { MANUAL_UNIT_FALLBACK } from "@/features/pendientes/presentation";
import {
  findPendingInView,
  listPendings,
} from "@/server/repositories/pending.repository";
import {
  PendingIdempotencyPayloadConflictError,
  registerPending,
} from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// Captura desde una cuenta COMPARTIDA (el mostrador) con vendedor escrito a
// mano, y producto manual sin presentación.
//
// Contra PostgreSQL real porque lo que se prueba es la columna nueva, el índice
// único de la clave de idempotencia y el `where` de visibilidad: un doble daría
// por buenas las tres cosas.
// --------------------------------------------------------------------------

const stamp = Date.now();
let counterId = "";
let sellerUserId = "";
let productId = "";
const manualNames: string[] = [];
let sequence = 0;

beforeAll(async () => {
  const counter = await prisma.user.create({
    data: { email: `mostrador-${stamp}@test.local`, name: "Mostrador" },
  });
  // Un usuario REGISTRADO con el mismo nombre que se escribe a mano: si el
  // texto influyera en la visibilidad, este sería quien lo vería.
  const sellerUser = await prisma.user.create({
    data: { email: `carlos-${stamp}@test.local`, name: "Carlos Gómez" },
  });
  const product = await prisma.product.create({
    data: { code: `SELLER-${stamp}`, name: `Seller product ${stamp}`, unit: "Caja" },
  });
  counterId = counter.id;
  sellerUserId = sellerUser.id;
  productId = product.id;
});

afterEach(async () => {
  const manual = await prisma.product.findMany({
    where: { name: { in: manualNames } },
    select: { id: true },
  });
  const ids = [productId, ...manual.map((product) => product.id)];
  await prisma.missingItem.deleteMany({ where: { productId: { in: ids } } });
  await prisma.pendingInventoryReservation.deleteMany({ where: { pending: { productId: { in: ids } } } });
  await prisma.pending.deleteMany({ where: { productId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: manual.map((product) => product.id) } } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: productId } });
});

function capture(overrides: Record<string, unknown> = {}) {
  sequence += 1;
  return {
    productId,
    createdById: counterId,
    quantity: sequence,
    idempotencyKey: randomUUID(),
    promisedAt: new Date("2030-01-01T00:00:00.000Z"),
    customerName: "Ana Pérez",
    customerPhone: "3001234567",
    ...overrides,
  };
}

describe("registerPending · vendedor escrito a mano", () => {
  it("lo persiste y deja a la cuenta autenticada como creadora", async () => {
    const result = await registerPending(capture({ manualSellerName: "Carlos Gómez" }));

    const stored = await prisma.pending.findUniqueOrThrow({ where: { id: result.pending.id } });
    expect(stored.manualSellerName).toBe("Carlos Gómez");
    expect(stored.createdById).toBe(counterId);
  });

  it("sin vendedor escrito la columna queda NULL", async () => {
    const result = await registerPending(capture());

    const stored = await prisma.pending.findUniqueOrThrow({ where: { id: result.pending.id } });
    expect(stored.manualSellerName).toBeNull();
  });

  it("no cambia quién ve el pendiente: la visibilidad sigue siendo por creador", async () => {
    const result = await registerPending(capture({ manualSellerName: "Carlos Gómez" }));

    const ofCounter = await listPendings({ ownerId: counterId, take: 100 });
    const row = ofCounter.items.find((item) => item.id === result.pending.id);
    expect(row?.manualSellerName).toBe("Carlos Gómez");
    expect(row?.createdBy).toEqual({ id: counterId, name: "Mostrador" });

    // El usuario registrado que se llama igual NO lo ve en su vista propia.
    const ofSeller = await listPendings({ ownerId: sellerUserId, take: 100 });
    expect(ofSeller.items.some((item) => item.id === result.pending.id)).toBe(false);
    expect(
      await findPendingInView({ id: result.pending.id, ownerId: sellerUserId }),
    ).toBeNull();
  });

  // La idempotencia sigue impidiendo el DUPLICADO, y el vendedor escrito queda
  // fuera de la huella: un reintento con otro nombre cae sobre la misma fila
  // sin reescribirla. El nombre se corrige desde la edición normal.
  it("un reintento con la misma clave no duplica, aunque cambie el vendedor escrito", async () => {
    const input = capture({ manualSellerName: "Carlos Gómez" });

    const first = await registerPending(input);
    const retries = await Promise.all([
      registerPending({ ...input, manualSellerName: "Otra persona" }),
      registerPending({ ...input, manualSellerName: undefined }),
    ]);
    for (const retry of retries) {
      expect(retry).toMatchObject({ replayed: true, pending: { id: first.pending.id } });
    }

    const rows = await prisma.pending.findMany({
      where: { idempotencyKey: input.idempotencyKey },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.manualSellerName).toBe("Carlos Gómez");
    expect(rows[0]!.requestFingerprint).not.toContain("manualSellerName");
  });

  it("un cambio REAL del pedido con la misma clave sigue siendo conflicto", async () => {
    const input = capture({ manualSellerName: "Carlos Gómez" });
    await registerPending(input);

    await expect(
      registerPending({ ...input, quantity: input.quantity + 1 }),
    ).rejects.toBeInstanceOf(PendingIdempotencyPayloadConflictError);
  });
});

describe("registerPending · producto manual sin presentación", () => {
  it("crea SIEMPRE un producto propio con el relleno: no se ata a otro del mismo nombre", async () => {
    const name = `Manual sin presentacion ${stamp}`;
    manualNames.push(name);
    const existing = await prisma.product.create({
      data: { code: `PREV-${stamp}`, name, unit: "Frasco" },
    });

    const result = await registerPending({
      ...capture({ productId: undefined }),
      manual: { name, unit: MANUAL_UNIT_FALLBACK },
    });

    expect(result.pending.productId).not.toBe(existing.id);
    const created = await prisma.product.findUniqueOrThrow({
      where: { id: result.pending.productId },
    });
    expect(created).toMatchObject({ name, unit: MANUAL_UNIT_FALLBACK, needsReview: true });
    expect(created.code).toMatch(/^MAN-/);
    // El existente queda intacto, presentación incluida.
    expect(await prisma.product.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({
      unit: "Frasco",
    });
  });
});

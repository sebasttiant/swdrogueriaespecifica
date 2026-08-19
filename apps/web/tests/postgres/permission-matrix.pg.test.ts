import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { listPendings } from "@/server/repositories/pending.repository";
import {
  cancelPendingCommitment,
  deliverPending,
} from "@/server/services/pending.service";

// Matriz de permisos (T4.4) contra PostgreSQL real. La bodega pasó a operar a
// nivel vendedor: el alcance de su cola y la denegación cross-owner son reglas
// que viven en el service/repository, no en la UI, y un doble en memoria no
// prueba ni la consulta por dueño ni que el rechazo no muta la fila.

let productId = "";
let sellerId = "";
let bodegaId = "";

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `PMX-${Date.now()}`, name: "Losartán", unit: "unidad" },
  });
  productId = product.id;

  const seller = await prisma.user.create({
    data: {
      email: `vendedor-${randomUUID()}@test.local`,
      name: "Vendedora",
      role: "OPERADOR",
    },
  });
  sellerId = seller.id;

  const bodega = await prisma.user.create({
    data: {
      email: `bodega-${randomUUID()}@test.local`,
      name: "Bodega",
      role: "BODEGA",
    },
  });
  bodegaId = bodega.id;
});

afterEach(async () => {
  await prisma.pendingDelivery.deleteMany({ where: { pending: { productId } } });
  await prisma.pending.deleteMany({ where: { productId } });
});

async function newPending(
  ownerId: string,
  options: { createdAt?: Date } = {},
): Promise<string> {
  const pending = await prisma.pending.create({
    data: {
      productId,
      quantity: 5,
      promisedAt: new Date("2026-09-01T15:00:00Z"),
      createdById: ownerId,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  });
  return pending.id;
}

describe("matriz de permisos · alcance de la cola (PostgreSQL real)", () => {
  it("BODEGA lista solo sus propios pendientes, nunca los ajenos", async () => {
    const propia = await newPending(bodegaId, {
      createdAt: new Date("2026-08-05T10:00:00Z"),
    });
    await newPending(sellerId, { createdAt: new Date("2026-08-04T10:00:00Z") });

    const { items } = await listPendings({ ownerId: bodegaId });

    expect(items.map((item) => item.id)).toEqual([propia]);
  });

  it("BODEGA no puede entregar un pendiente ajeno: NOT_OWNER sin mutación", async () => {
    const ajeno = await newPending(sellerId);

    const result = await deliverPending({
      id: ajeno,
      deliveredById: bodegaId,
      quantity: 1,
      canManageAll: false,
    });

    expect(result).toEqual({ pending: null, rejection: "NOT_OWNER" });
    const intacto = await prisma.pending.findUniqueOrThrow({ where: { id: ajeno } });
    expect(intacto.deliveredQuantity).toBe(0);
    expect(intacto.status).toBe("PENDIENTE");
    const entregas = await prisma.pendingDelivery.count({ where: { pendingId: ajeno } });
    expect(entregas).toBe(0);
  });

  it("BODEGA no puede cancelar un pendiente ajeno: NOT_OWNER y sigue activo", async () => {
    const ajeno = await newPending(sellerId);

    const result = await cancelPendingCommitment({
      id: ajeno,
      cancelledById: bodegaId,
      canManageAll: false,
    });

    expect(result).toEqual({ pending: null, rejection: "NOT_OWNER" });
    const intacto = await prisma.pending.findUniqueOrThrow({ where: { id: ajeno } });
    expect(intacto.status).toBe("PENDIENTE");
  });
});
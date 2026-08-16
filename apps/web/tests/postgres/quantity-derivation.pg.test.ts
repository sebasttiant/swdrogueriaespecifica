import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { appendMovement } from "@/server/repositories/inventory-movement.repository";
import { createLot } from "@/server/repositories/lot.repository";
import { recordCommand } from "@/server/repositories/operational-command.repository";
import {
  computeActiveReserved,
  computeAvailable,
  verifyConservationInvariant,
} from "@/server/repositories/quantity-derivation.repository";

// La derivación se prueba contra PostgreSQL real: lo que se está verificando es
// que las sumas del ledger y la columna del lote cuenten la misma historia, y
// eso solo se ve cuando las dos viven en la misma base.

const ACTOR = "actor-derivacion";
let productId = "";

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `DERIV-${Date.now()}`, name: "Amoxicilina", unit: "unidad" },
  });
  productId = product.id;
});

afterEach(async () => {
  // El orden importa: los movimientos sostienen al lote con RESTRICT, así que
  // el lote no se puede borrar antes que su historia.
  await prisma.inventoryMovement.deleteMany({ where: { productId } });
  await prisma.operationalCommand.deleteMany({ where: { actorId: ACTOR } });
  await prisma.lot.deleteMany({ where: { productId } });
});

async function newLot(onHand = 0): Promise<string> {
  const lot = await createLot({
    productId,
    lotNumber: `L-${randomUUID().slice(0, 8)}`,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
    onHand,
  });
  return lot.id;
}

/** Asienta un movimiento con su comando, que es lo que el ledger exige. */
async function rawMovement(
  lotId: string,
  type: "RECEIPT" | "RESERVATION" | "RELEASE" | "DELIVERY",
  quantity: number,
): Promise<void> {
  const command = await recordCommand({
    actorId: ACTOR,
    commandType: "inventory.fixture",
    commandKey: randomUUID(),
    fingerprint: "f".repeat(64),
    result: { ok: true },
  });
  await appendMovement({
    lotId,
    productId,
    type,
    quantity,
    actorId: ACTOR,
    commandId: command.id,
  });
}

describe("computeActiveReserved", () => {
  it("suma las reservas y resta las liberaciones del ledger", async () => {
    const lotId = await newLot();
    await rawMovement(lotId, "RESERVATION", 10);
    await rawMovement(lotId, "RESERVATION", 10);
    await rawMovement(lotId, "RELEASE", -5);

    expect(await computeActiveReserved(lotId)).toBe(15);
  });

  it("ignora los movimientos físicos: no comprometen nada", async () => {
    const lotId = await newLot();
    await rawMovement(lotId, "RECEIPT", 100);
    await rawMovement(lotId, "DELIVERY", -40);

    expect(await computeActiveReserved(lotId)).toBe(0);
  });
});

describe("computeAvailable", () => {
  it("es lo que hay menos lo comprometido", () => {
    expect(computeAvailable(100, 15)).toBe(85);
    expect(computeAvailable(0, 0)).toBe(0);
  });
});

describe("verifyConservationInvariant", () => {
  it("confirma que la columna coincide con el ledger", async () => {
    const lotId = await newLot(30);
    await rawMovement(lotId, "RECEIPT", 50);
    await rawMovement(lotId, "DELIVERY", -20);
    await rawMovement(lotId, "RESERVATION", 10);

    const estado = await verifyConservationInvariant(lotId);

    expect(estado.onHand).toBe(30);
    expect(estado.ledgerOnHand).toBe(30);
    expect(estado.activeReserved).toBe(10);
    expect(estado.available).toBe(20);
    expect(estado.valid).toBe(true);
  });

  // La columna es una proyección del ledger, y el ledger manda. Un lote con
  // stock que ningún movimiento explica es exactamente lo que el cutover tiene
  // que reconciliar: el detector existe para encontrarlos.
  it("detecta la deriva de un lote cuyo stock no explica el ledger", async () => {
    const lotId = await newLot(7);

    const estado = await verifyConservationInvariant(lotId);

    expect(estado.onHand).toBe(7);
    expect(estado.ledgerOnHand).toBe(0);
    expect(estado.valid).toBe(false);
  });

  // Comprometer más de lo que hay es un estado inválido aunque la columna y el
  // ledger coincidan: el disponible queda en negativo.
  it("marca como inválido un lote con más comprometido que stock", async () => {
    const lotId = await newLot(10);
    await rawMovement(lotId, "RECEIPT", 10);
    await rawMovement(lotId, "RESERVATION", 15);

    const estado = await verifyConservationInvariant(lotId);

    expect(estado.available).toBe(-5);
    expect(estado.valid).toBe(false);
  });
});

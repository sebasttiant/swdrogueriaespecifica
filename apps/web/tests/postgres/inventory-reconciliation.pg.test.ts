import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { createLot } from "@/server/repositories/lot.repository";
import { computeAndApplyQuantities } from "@/server/repositories/quantity-derivation.repository";
import { reconcileInventory } from "@/server/services/inventory-reconciliation.service";

// El reconciliador existe para poder mirar una copia RESTAURADA de producción
// sin arruinarla. El verificador que ya había (`db:verify`) empieza borrando
// tablas, así que sirve para un entorno descartable y para nada más.
//
// Por eso el test que más importa acá no es ninguno de los que detecta un
// problema: es el que prueba que la corrida NO ESCRIBE NADA.

const ACTOR = "actor-reconciliacion";
let productId = "";
let otroProductId = "";

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `RECON-${Date.now()}`, name: "Metformina", unit: "unidad" },
  });
  productId = product.id;

  const otro = await prisma.product.create({
    data: { code: `RECON-OTRO-${Date.now()}`, name: "Atorvastatina", unit: "unidad" },
  });
  otroProductId = otro.id;
});

afterEach(async () => {
  await prisma.inventoryMovement.deleteMany({ where: { productId: { in: [productId, otroProductId] } } });
  await prisma.operationalCommand.deleteMany({ where: { actorId: ACTOR } });
  await prisma.lot.deleteMany({ where: { productId: { in: [productId, otroProductId] } } });
});

/** Lote cuyo stock lo explica el ledger: el estado sano. */
async function lotWithLedger(units: number, owner = productId): Promise<string> {
  const lot = await createLot({
    productId: owner,
    lotNumber: `L-${randomUUID().slice(0, 8)}`,
    onHand: 0,
  });

  await prisma.$transaction((tx) =>
    computeAndApplyQuantities(
      {
        lotId: lot.id,
        actorId: ACTOR,
        commandType: "inventory.receipt",
        commandKey: randomUUID(),
        quantityDelta: units,
        moveType: "RECEIPT",
      },
      tx,
    ),
  );

  return lot.id;
}

/** Lote nacido con stock que ningún movimiento explica: el caso del cutover. */
async function lotWithoutLedger(units: number): Promise<string> {
  const lot = await createLot({
    productId,
    lotNumber: `L-${randomUUID().slice(0, 8)}`,
    onHand: units,
  });
  return lot.id;
}

describe("reconcileInventory", () => {
  it("no reporta nada cuando el ledger explica el stock", async () => {
    await lotWithLedger(40);

    const informe = await reconcileInventory({ productId });

    expect(informe.checkedLots).toBe(1);
    expect(informe.findings).toEqual([]);
    expect(informe.healthy).toBe(true);
  });

  // Un lote con stock que ninguna historia explica es exactamente lo que el
  // cutover tiene que reconciliar. Encontrarlos ES el trabajo de esto.
  it("detecta el stock que el ledger no explica", async () => {
    const huerfano = await lotWithoutLedger(7);

    const informe = await reconcileInventory({ productId });

    expect(informe.healthy).toBe(false);
    expect(informe.findings).toHaveLength(1);
    const hallazgo = informe.findings[0]!;
    expect(hallazgo.lotId).toBe(huerfano);
    expect(hallazgo.onHand).toBe(7);
    expect(hallazgo.ledgerOnHand).toBe(0);
    expect(hallazgo.issues).toContain("COLUMN_DRIFT");
  });

  // Prometido más de lo que hay: el disponible queda negativo. Puede pasar por
  // una migración vieja o por un asiento hecho fuera del servicio.
  it("detecta un lote sobre-comprometido", async () => {
    const lotId = await lotWithLedger(10);
    // Se compromete de más saltándose la guarda, que es como llegaría un dato
    // heredado: asentando directo en el ledger.
    const command = await prisma.operationalCommand.create({
      data: {
        actorId: ACTOR,
        commandType: "legado.reserva",
        commandKey: randomUUID(),
        fingerprint: "f".repeat(64),
        result: { ok: true },
      },
    });
    await prisma.inventoryMovement.create({
      data: {
        lotId,
        productId,
        type: "RESERVATION",
        quantity: 25,
        actorId: ACTOR,
        commandId: command.id,
      },
    });

    const informe = await reconcileInventory({ productId });

    const hallazgo = informe.findings[0]!;
    expect(hallazgo.available).toBe(-15);
    expect(hallazgo.issues).toContain("OVERCOMMITTED");
  });

  it("acota la revisión a un producto cuando se lo piden", async () => {
    await lotWithoutLedger(5);
    await lotWithLedger(10, otroProductId);

    const informe = await reconcileInventory({ productId: otroProductId });

    expect(informe.checkedLots).toBe(1);
    expect(informe.findings).toEqual([]);
  });

  it("recorre todos los lotes aunque entren en varias páginas", async () => {
    await lotWithLedger(1);
    await lotWithLedger(2);
    await lotWithLedger(3);
    await lotWithoutLedger(9);

    const informe = await reconcileInventory({ productId, batchSize: 2 });

    expect(informe.checkedLots).toBe(4);
    expect(informe.findings).toHaveLength(1);
  });

  // LA propiedad que define este slice. Sin esto, correrlo contra una copia
  // restaurada sería tan peligroso como el verificador que ya existía.
  it("no escribe absolutamente nada", async () => {
    await lotWithLedger(20);
    await lotWithoutLedger(6);

    const antes = await snapshot();
    await reconcileInventory({ productId });
    const despues = await snapshot();

    expect(despues).toEqual(antes);
  });
});

/** Foto de todo lo que el reconciliador podría llegar a tocar. */
async function snapshot() {
  const [lots, movements, commands] = await Promise.all([
    prisma.lot.findMany({
      where: { productId },
      select: { id: true, onHand: true, status: true, updatedAt: true },
      orderBy: { id: "asc" },
    }),
    prisma.inventoryMovement.count({ where: { productId } }),
    prisma.operationalCommand.count({ where: { actorId: ACTOR } }),
  ]);
  return { lots, movements, commands };
}

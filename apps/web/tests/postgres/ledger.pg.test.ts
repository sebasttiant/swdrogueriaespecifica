import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  appendMovement,
  findMovementById,
  listMovementsByLot,
  listMovementsByProduct,
} from "@/server/repositories/inventory-movement.repository";
import { createLot } from "@/server/repositories/lot.repository";
import { recordCommand } from "@/server/repositories/operational-command.repository";

// El ledger se prueba contra PostgreSQL real porque lo que lo hace un ledger
// son garantías de la base: que no se pueda borrar un lote con historia, que un
// comando no asiente dos veces, y que el asiento y su comando caigan juntos si
// algo falla en el medio.

const ACTOR = "actor-ledger";
let productId = "";
let lotId = "";

async function newCommand(result: unknown = { ok: true }): Promise<string> {
  const command = await recordCommand({
    actorId: ACTOR,
    commandType: "inventory.receipt",
    commandKey: randomUUID(),
    fingerprint: "f".repeat(64),
    result: result as never,
  });
  return command.id;
}

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `LEDGER-${Date.now()}`, name: "Ibuprofeno", unit: "unidad" },
  });
  productId = product.id;
  const lot = await createLot({
    productId,
    lotNumber: `L-${Date.now()}`,
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    onHand: 10,
  });
  lotId = lot.id;
});

afterEach(async () => {
  await prisma.inventoryMovement.deleteMany({ where: { productId } });
  await prisma.operationalCommand.deleteMany({ where: { actorId: ACTOR } });
});

describe("appendMovement", () => {
  it("asienta el movimiento y lo devuelve intacto al releerlo", async () => {
    const commandId = await newCommand();
    const occurredAt = new Date("2026-08-15T10:00:00Z");

    const movement = await appendMovement({
      lotId,
      productId,
      type: "RECEIPT",
      quantity: 10,
      actorId: ACTOR,
      commandId,
      occurredAt,
    });

    const reread = await findMovementById(movement.id);
    expect(reread?.type).toBe("RECEIPT");
    expect(reread?.quantity).toBe(10);
    expect(reread?.occurredAt.toISOString()).toBe(occurredAt.toISOString());
    expect(reread?.commandId).toBe(commandId);
  });

  // El delta es firmado: el ledger guarda el hecho bruto, y el signo es parte
  // del hecho. Restar no es un tipo distinto de asiento.
  it("acepta deltas negativos, que es como se resta stock", async () => {
    const movement = await appendMovement({
      lotId,
      productId,
      type: "DELIVERY",
      quantity: -4,
      actorId: ACTOR,
      commandId: await newCommand(),
    });

    expect(movement.quantity).toBe(-4);
  });

  // Un comando asienta UNA vez. Sin esto, un reintento que llegara al INSERT
  // duplicaría el movimiento y el stock quedaría mal para siempre.
  it("no deja que un mismo comando asiente dos veces", async () => {
    const commandId = await newCommand();
    await appendMovement({
      lotId,
      productId,
      type: "RECEIPT",
      quantity: 5,
      actorId: ACTOR,
      commandId,
    });

    const duplicate = await appendMovement({
      lotId,
      productId,
      type: "RECEIPT",
      quantity: 5,
      actorId: ACTOR,
      commandId,
    }).catch((error: unknown) => error);

    expect(duplicate).toBeInstanceOf(Error);
    expect(await prisma.inventoryMovement.count({ where: { commandId } })).toBe(1);
  });

  // LA garantía del slice: la historia no se borra por arrastre. Este es el
  // test de la nota heredada de T1.2 sobre CASCADE contra RESTRICT.
  it("impide borrar un lote que ya tiene movimientos", async () => {
    const doomed = await createLot({
      productId,
      lotNumber: `L-doomed-${Date.now()}`,
      expiresAt: null,
      onHand: 1,
    });
    await appendMovement({
      lotId: doomed.id,
      productId,
      type: "RECEIPT",
      quantity: 1,
      actorId: ACTOR,
      commandId: await newCommand(),
    });

    const failure = await prisma.lot
      .delete({ where: { id: doomed.id } })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(await prisma.lot.count({ where: { id: doomed.id } })).toBe(1);
  });

  // El comando y su asiento son un solo hecho: si el efecto falla a mitad de
  // camino, no puede quedar el comando prometiendo algo que no ocurrió.
  it("revierte comando y asiento juntos cuando el efecto falla", async () => {
    const commandKey = randomUUID();

    const failure = await prisma
      .$transaction(async (tx) => {
        const command = await recordCommand(
          {
            actorId: ACTOR,
            commandType: "inventory.receipt",
            commandKey,
            fingerprint: "f".repeat(64),
            result: { ok: true },
          },
          tx,
        );
        await appendMovement(
          {
            lotId,
            productId,
            type: "RECEIPT",
            quantity: 7,
            actorId: ACTOR,
            commandId: command.id,
          },
          tx,
        );
        throw new Error("el efecto falló después de asentar");
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(await prisma.operationalCommand.count({ where: { commandKey } })).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { quantity: 7 } })).toBe(0);
  });
});

describe("lecturas del ledger", () => {
  it("lista los movimientos del lote, del más reciente al más viejo", async () => {
    const viejo = await appendMovement({
      lotId,
      productId,
      type: "RECEIPT",
      quantity: 10,
      actorId: ACTOR,
      commandId: await newCommand(),
      occurredAt: new Date("2026-08-01T10:00:00Z"),
    });
    const nuevo = await appendMovement({
      lotId,
      productId,
      type: "DELIVERY",
      quantity: -2,
      actorId: ACTOR,
      commandId: await newCommand(),
      occurredAt: new Date("2026-08-10T10:00:00Z"),
    });

    const page = await listMovementsByLot(lotId);

    expect(page.items.map((row) => row.id)).toEqual([nuevo.id, viejo.id]);
    expect(page.nextCursor).toBeNull();
  });

  it("pagina sin repetir ni saltear asientos", async () => {
    for (let index = 0; index < 3; index += 1) {
      await appendMovement({
        lotId,
        productId,
        type: "RECEIPT",
        quantity: 1,
        actorId: ACTOR,
        commandId: await newCommand(),
        occurredAt: new Date(Date.UTC(2026, 7, index + 1)),
      });
    }

    const first = await listMovementsByLot(lotId, { take: 2 });
    const second = await listMovementsByLot(lotId, {
      take: 2,
      cursor: first.nextCursor,
    });

    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    const ids = [...first.items, ...second.items].map((row) => row.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("filtra los movimientos del producto por tipo", async () => {
    await appendMovement({
      lotId,
      productId,
      type: "RECEIPT",
      quantity: 5,
      actorId: ACTOR,
      commandId: await newCommand(),
    });
    const entrega = await appendMovement({
      lotId,
      productId,
      type: "DELIVERY",
      quantity: -1,
      actorId: ACTOR,
      commandId: await newCommand(),
    });

    const page = await listMovementsByProduct(productId, { type: "DELIVERY" });

    expect(page.items.map((row) => row.id)).toEqual([entrega.id]);
  });
});

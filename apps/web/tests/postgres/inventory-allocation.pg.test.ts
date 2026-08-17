import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { createLot } from "@/server/repositories/lot.repository";
import {
  computeAndApplyQuantities,
  verifyConservationInvariant,
} from "@/server/repositories/quantity-derivation.repository";
import {
  AllocationKeyReusedError,
  deliverAllocation,
  planProductReservation,
  releaseAllocation,
  reserveAllocation,
} from "@/server/services/inventory-allocation.service";

// El reparto se prueba contra PostgreSQL real porque lo que importa acá no es
// la aritmética —esa ya está probada en el planificador puro— sino que las
// líneas de un plan caigan TODAS o NINGUNA, que un plan viejo se rechace en vez
// de aplicarse a medias, y que un reintento no descuente dos veces.

const ACTOR = "actor-reparto";
let productId = "";

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `ALLOC-${Date.now()}`, name: "Enalapril", unit: "unidad" },
  });
  productId = product.id;
});

afterEach(async () => {
  await prisma.inventoryMovement.deleteMany({ where: { productId } });
  await prisma.operationalCommand.deleteMany({ where: { actorId: ACTOR } });
  await prisma.lot.deleteMany({ where: { productId } });
});

/** Lote con stock explicado por el ledger, que es la única forma válida. */
async function stockedLot(units: number, expiresAt: Date | null): Promise<string> {
  const lot = await createLot({
    productId,
    lotNumber: `L-${randomUUID().slice(0, 8)}`,
    ...(expiresAt ? { expiresAt } : {}),
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

function keys(howMany: number): string[] {
  return Array.from({ length: howMany }, () => randomUUID());
}

describe("reserveAllocation", () => {
  it("compromete lo disponible y deja el estante intacto", async () => {
    const lotId = await stockedLot(50, new Date("2027-01-01T00:00:00Z"));
    const plan = await planProductReservation({ productId, quantity: 20 });

    await prisma.$transaction((tx) =>
      reserveAllocation(
        { plan, actorId: ACTOR, commandType: "pending.reserve", commandKeys: keys(1) },
        tx,
      ),
    );

    const estado = await verifyConservationInvariant(lotId);
    expect(estado.onHand).toBe(50); // el frasco sigue en el estante
    expect(estado.activeReserved).toBe(20);
    expect(estado.available).toBe(30);
    expect(estado.valid).toBe(true);
  });

  // FEFO de verdad: el que vence antes se agota primero. Lo contrario es tirar
  // mercadería a la basura teniendo con qué haberla vendido.
  it("agota el lote que vence antes y sigue por el siguiente", async () => {
    const venceAntes = await stockedLot(10, new Date("2026-10-01T00:00:00Z"));
    const venceDespues = await stockedLot(40, new Date("2027-05-01T00:00:00Z"));

    const plan = await planProductReservation({ productId, quantity: 25 });
    expect(plan.lines).toEqual([
      { lotId: venceAntes, quantity: 10 },
      { lotId: venceDespues, quantity: 15 },
    ]);

    await prisma.$transaction((tx) =>
      reserveAllocation(
        { plan, actorId: ACTOR, commandType: "pending.reserve", commandKeys: keys(2) },
        tx,
      ),
    );

    expect((await verifyConservationInvariant(venceAntes)).available).toBe(0);
    expect((await verifyConservationInvariant(venceDespues)).available).toBe(25);
  });

  it("exige una clave de idempotencia por línea", async () => {
    await stockedLot(10, null);
    const plan = await planProductReservation({ productId, quantity: 5 });

    await expect(
      prisma.$transaction((tx) =>
        reserveAllocation(
          { plan, actorId: ACTOR, commandType: "pending.reserve", commandKeys: [] },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });

  // El plan se arma leyendo, sin lock. Entre planificar y aplicar otro puede
  // haberse llevado el stock. El aplicador toma el lock y vuelve a mirar: si el
  // plan quedó viejo, se cae ENTERO en vez de comprometer de más.
  it("rechaza entero un plan que quedó viejo, sin aplicar nada a medias", async () => {
    const lotId = await stockedLot(10, null);
    const plan = await planProductReservation({ productId, quantity: 10 });

    // Alguien se adelanta y compromete el mismo stock.
    await prisma.$transaction((tx) =>
      computeAndApplyQuantities(
        {
          lotId,
          actorId: ACTOR,
          commandType: "otro.flujo",
          commandKey: randomUUID(),
          quantityDelta: 6,
          moveType: "RESERVATION",
        },
        tx,
      ),
    );

    await expect(
      prisma.$transaction((tx) =>
        reserveAllocation(
          { plan, actorId: ACTOR, commandType: "pending.reserve", commandKeys: keys(1) },
          tx,
        ),
      ),
    ).rejects.toThrow();

    // Lo del otro quedó; lo nuestro no dejó rastro.
    const estado = await verifyConservationInvariant(lotId);
    expect(estado.activeReserved).toBe(6);
    expect(estado.available).toBe(4);
  });
});

describe("releaseAllocation", () => {
  it("devuelve lo comprometido y el disponible vuelve a donde estaba", async () => {
    const lotId = await stockedLot(30, null);
    const plan = await planProductReservation({ productId, quantity: 12 });
    const reserva = keys(1);

    await prisma.$transaction((tx) =>
      reserveAllocation(
        { plan, actorId: ACTOR, commandType: "pending.reserve", commandKeys: reserva },
        tx,
      ),
    );
    expect((await verifyConservationInvariant(lotId)).available).toBe(18);

    await prisma.$transaction((tx) =>
      releaseAllocation(
        { plan, actorId: ACTOR, commandType: "pending.cancel", commandKeys: keys(1) },
        tx,
      ),
    );

    const estado = await verifyConservationInvariant(lotId);
    expect(estado.activeReserved).toBe(0);
    expect(estado.available).toBe(30);
    expect(estado.onHand).toBe(30); // cancelar no devuelve stock: nunca salió
  });
});

describe("deliverAllocation", () => {
  // Entregar lo reservado son DOS asientos por lote: uno suelta la promesa y
  // otro saca la unidad. El ledger admite un asiento por comando, así que son
  // dos comandos —y en este orden, porque sacar sin soltar rompería la promesa.
  it("saca del estante y consume la reserva de una vez", async () => {
    const lotId = await stockedLot(40, null);
    const plan = await planProductReservation({ productId, quantity: 15 });

    await prisma.$transaction((tx) =>
      reserveAllocation(
        { plan, actorId: ACTOR, commandType: "pending.reserve", commandKeys: keys(1) },
        tx,
      ),
    );

    await prisma.$transaction((tx) =>
      deliverAllocation(
        {
          plan,
          actorId: ACTOR,
          commandType: "pending.deliver",
          releaseKeys: keys(1),
          deliveryKeys: keys(1),
        },
        tx,
      ),
    );

    const estado = await verifyConservationInvariant(lotId);
    expect(estado.onHand).toBe(25);
    expect(estado.activeReserved).toBe(0);
    expect(estado.available).toBe(25);
    expect(estado.valid).toBe(true);
  });

  // Exactly-once: no lo da un flag de "ya consumido" sino la identidad del
  // comando. Reintentar con las mismas claves no puede descontar dos veces.
  it("un reintento con las mismas claves no descuenta dos veces", async () => {
    const lotId = await stockedLot(40, null);
    const plan = await planProductReservation({ productId, quantity: 15 });
    const releaseKeys = keys(1);
    const deliveryKeys = keys(1);

    await prisma.$transaction((tx) =>
      reserveAllocation(
        { plan, actorId: ACTOR, commandType: "pending.reserve", commandKeys: keys(1) },
        tx,
      ),
    );
    const entrega = () =>
      prisma.$transaction((tx) =>
        deliverAllocation(
          { plan, actorId: ACTOR, commandType: "pending.deliver", releaseKeys, deliveryKeys },
          tx,
        ),
      );

    const primera = await entrega();
    const reintento = await entrega();

    // El reintento DEVUELVE lo que pasó, no vuelve a hacerlo: mismos asientos.
    expect(reintento.map((linea) => linea.movementId)).toEqual(
      primera.map((linea) => linea.movementId),
    );

    const estado = await verifyConservationInvariant(lotId);
    expect(estado.onHand).toBe(25); // descontó una vez, no dos
    expect(estado.activeReserved).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { lotId, type: "DELIVERY" } })).toBe(1);
  });

  // Reusar una clave para otra línea no puede pasar en silencio: esa línea se
  // quedaría sin asentar y el reparto saldría corto sin que nada falle.
  it("rechaza una clave ya usada para otra línea", async () => {
    const lotId = await stockedLot(40, null);
    const plan = await planProductReservation({ productId, quantity: 15 });
    const reserva = keys(1);

    await prisma.$transaction((tx) =>
      reserveAllocation(
        { plan, actorId: ACTOR, commandType: "pending.reserve", commandKeys: reserva },
        tx,
      ),
    );

    const otroPlan = await planProductReservation({ productId, quantity: 5 });
    await expect(
      prisma.$transaction((tx) =>
        reserveAllocation(
          { plan: otroPlan, actorId: ACTOR, commandType: "pending.reserve", commandKeys: reserva },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(AllocationKeyReusedError);

    expect((await verifyConservationInvariant(lotId)).activeReserved).toBe(15);
  });
});

describe("planProductReservation", () => {
  it("informa el déficit cuando el producto no alcanza", async () => {
    await stockedLot(4, null);

    const plan = await planProductReservation({ productId, quantity: 10 });

    expect(plan.allocated).toBe(4);
    expect(plan.shortfall).toBe(6);
  });

  // Un lote vencido no se reparte aunque tenga unidades: `listEligibleLots` ya
  // lo excluye, y esa exclusión tiene que llegar hasta el plan.
  it("no reparte lotes vencidos", async () => {
    await stockedLot(50, new Date("2020-01-01T00:00:00Z"));

    const plan = await planProductReservation({ productId, quantity: 10 });

    expect(plan.lines).toEqual([]);
    expect(plan.shortfall).toBe(10);
  });

  // Lo comprometido ya no está disponible para un plan nuevo, aunque el estante
  // siga lleno. Sin esto se prometería dos veces la misma unidad.
  it("descuenta lo ya comprometido al planificar", async () => {
    const lotId = await stockedLot(20, null);
    const primero = await planProductReservation({ productId, quantity: 15 });
    await prisma.$transaction((tx) =>
      reserveAllocation(
        { plan: primero, actorId: ACTOR, commandType: "pending.reserve", commandKeys: keys(1) },
        tx,
      ),
    );

    const segundo = await planProductReservation({ productId, quantity: 10 });

    expect(segundo.lines).toEqual([{ lotId, quantity: 5 }]);
    expect(segundo.shortfall).toBe(5);
  });
});

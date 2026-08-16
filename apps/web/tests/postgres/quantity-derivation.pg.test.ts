import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { appendMovement } from "@/server/repositories/inventory-movement.repository";
import { createLot } from "@/server/repositories/lot.repository";
import { recordCommand } from "@/server/repositories/operational-command.repository";
import {
  computeActiveReserved,
  computeAndApplyQuantities,
  computeAvailable,
  InsufficientAvailableError,
  InsufficientStockError,
  LotNotFoundError,
  ReleaseExceedsReservedError,
  verifyConservationInvariant,
} from "@/server/repositories/quantity-derivation.repository";

// La derivación se prueba contra PostgreSQL real: lo que se está verificando es
// que las sumas del ledger y la columna del lote cuenten la misma historia, y
// eso solo se ve cuando las dos viven en la misma base. Lo mismo vale para el
// lock de fila que impide que dos reservas simultáneas vendan la misma unidad:
// contra un doble en memoria pasa en verde sin probar nada.

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

/** Aplica un movimiento por la vía canónica, en su propia transacción. */
function apply(
  lotId: string,
  moveType: "RECEIPT" | "RESERVATION" | "RELEASE" | "DELIVERY" | "ADJUSTMENT",
  quantityDelta: number,
) {
  return prisma.$transaction((tx) =>
    computeAndApplyQuantities(
      {
        lotId,
        actorId: ACTOR,
        commandType: "inventory.test",
        commandKey: randomUUID(),
        quantityDelta,
        moveType,
      },
      tx,
    ),
  );
}

describe("computeAndApplyQuantities", () => {
  // El CHECK de la base es la última red, pero para cuando salta ya abortó la
  // transacción. El WHERE del UPDATE rechaza antes, con un error tipado que el
  // llamador puede leer.
  it("rechaza un movimiento físico que dejaría onHand negativo", async () => {
    const lotId = await newLot();
    await apply(lotId, "RECEIPT", 10);

    await expect(apply(lotId, "ADJUSTMENT", -15)).rejects.toBeInstanceOf(
      InsufficientStockError,
    );

    // Rechazado significa que no pasó nada: ni el asiento ni el descuento.
    const lot = await prisma.lot.findUniqueOrThrow({ where: { id: lotId } });
    expect(lot.onHand).toBe(10);
    expect(await prisma.inventoryMovement.count({ where: { lotId } })).toBe(1);
  });

  // Reservar es prometer, no mover: la unidad sigue en el estante. Si la
  // reserva descontara onHand, el mismo compromiso se contaría dos veces.
  it("la reserva no toca onHand, solo compromete lo disponible", async () => {
    const lotId = await newLot();
    await apply(lotId, "RECEIPT", 100);

    const resultado = await apply(lotId, "RESERVATION", 15);

    expect(resultado.newOnHand).toBe(100);
    expect(resultado.newActiveReserved).toBe(15);
    expect(resultado.available).toBe(85);
    expect(resultado.conserved).toBe(true);
  });

  it("rechaza una reserva que excede lo disponible", async () => {
    const lotId = await newLot();
    await apply(lotId, "RECEIPT", 20);
    await apply(lotId, "RESERVATION", 15);

    await expect(apply(lotId, "RESERVATION", 10)).rejects.toBeInstanceOf(
      InsufficientAvailableError,
    );
  });

  // Sacar del estante algo prometido a otro rompe la promesa igual que
  // sobre-reservar. Para entregar lo reservado, primero se libera.
  it("rechaza una entrega que se comería lo comprometido", async () => {
    const lotId = await newLot();
    await apply(lotId, "RECEIPT", 20);
    await apply(lotId, "RESERVATION", 15);

    await expect(apply(lotId, "DELIVERY", -10)).rejects.toBeInstanceOf(
      InsufficientAvailableError,
    );
  });

  // Liberar de más dejaría lo comprometido en negativo, y entonces el
  // disponible superaría a lo que hay en el estante.
  it("rechaza una liberación mayor que lo comprometido", async () => {
    const lotId = await newLot();
    await apply(lotId, "RECEIPT", 20);
    await apply(lotId, "RESERVATION", 5);

    await expect(apply(lotId, "RELEASE", -10)).rejects.toBeInstanceOf(
      ReleaseExceedsReservedError,
    );
  });

  it("rechaza un movimiento sobre un lote inexistente", async () => {
    await expect(apply("lote-que-no-existe", "RECEIPT", 5)).rejects.toBeInstanceOf(
      LotNotFoundError,
    );
  });

  // El signo es parte del hecho asentado. Una liberación guardada en positivo
  // sumaría a lo comprometido en lugar de restarlo, y la derivación quedaría
  // muda: el número saldría mal sin que nada falle.
  it("exige el signo que corresponde al tipo de movimiento", async () => {
    const lotId = await newLot();

    await expect(apply(lotId, "RESERVATION", -5)).rejects.toBeInstanceOf(RangeError);
    await expect(apply(lotId, "RELEASE", 5)).rejects.toBeInstanceOf(RangeError);
    await expect(apply(lotId, "RECEIPT", 0)).rejects.toBeInstanceOf(RangeError);
  });

  // Dos operarios reservando el mismo lote al mismo tiempo.
  //
  // Lanzar las dos reservas con un `Promise.all` NO alcanza para probar esto:
  // en la práctica la segunda arranca cuando la primera ya commiteó, ve el
  // número nuevo y el test pasa en verde aunque no exista ningún lock. Para que
  // el solapamiento sea real hay que sostener la primera transacción ABIERTA
  // mientras la segunda lee. Con el lock, la segunda espera y después ve los 15
  // comprometidos; sin el lock, lee un cero viejo y el lote se vende dos veces.
  it("dos reservas simultáneas no sobre-venden el lote", async () => {
    const lotId = await newLot();
    await apply(lotId, "RECEIPT", 20);

    let primeraReservo!: () => void;
    const yaReservo = new Promise<void>((resolve) => (primeraReservo = resolve));
    let dejarCommitear!: () => void;
    const puedeCommitear = new Promise<void>((resolve) => (dejarCommitear = resolve));

    const primera = prisma.$transaction(async (tx) => {
      const resultado = await computeAndApplyQuantities(
        {
          lotId,
          actorId: ACTOR,
          commandType: "inventory.test",
          commandKey: randomUUID(),
          quantityDelta: 15,
          moveType: "RESERVATION",
        },
        tx,
      );
      primeraReservo();
      await puedeCommitear; // la transacción sigue abierta: el lock sigue tomado
      return resultado;
    });

    await yaReservo;
    const segunda = apply(lotId, "RESERVATION", 15);
    // Tiempo para que la segunda llegue al lock y se quede esperando ahí.
    await new Promise((resolve) => setTimeout(resolve, 300));
    dejarCommitear();

    const resultados = await Promise.allSettled([primera, segunda]);
    const cumplidas = resultados.filter((r) => r.status === "fulfilled");
    const rechazadas = resultados.filter((r) => r.status === "rejected");
    expect(cumplidas).toHaveLength(1);
    expect(rechazadas).toHaveLength(1);
    expect((rechazadas[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      InsufficientAvailableError,
    );

    const estado = await verifyConservationInvariant(lotId);
    expect(estado.activeReserved).toBe(15);
    expect(estado.available).toBe(5);
    expect(estado.valid).toBe(true);
  });
});

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

// --------------------------------------------------------------------------
// Derivación de cantidades — traduce el ledger a los tres números con los que
// opera el negocio: lo que hay, lo comprometido y lo que se puede vender.
//
// El ledger manda. `lots.onHand` es una PROYECCIÓN suya: se mantiene al día
// dentro de la misma transacción que asienta el movimiento, y por eso puede
// leerse de una sola fila en vez de sumar una historia que crece para siempre.
// Cuando la columna y el ledger discrepan, el que tiene razón es el ledger:
// `verifyConservationInvariant` existe para encontrar esas discrepancias.
//
// Los tipos de movimiento se reparten en dos planos que NO se mezclan:
//
//   físico       RECEIPT, DELIVERY, ADJUSTMENT, RETURN, EXPIRY → mueve onHand
//   compromiso   RESERVATION, RELEASE                          → mueve reservado
//
// Reservar no mueve stock: la unidad sigue en el estante, prometida a alguien.
// Si la reserva descontara `onHand` además de sumar a lo comprometido, el mismo
// compromiso se contaría dos veces y `onHand = available + activeReserved`
// dejaría de cerrar en el primer movimiento.
//
// Entregar algo reservado son DOS comandos encadenados —un RELEASE que suelta
// la promesa y un DELIVERY que saca la unidad— porque el ledger admite un solo
// asiento por comando (`@@unique([commandId])`).
// --------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { prisma } from "@/lib/db/prisma";
import type { InventoryMovementType, Prisma } from "@/lib/generated/prisma/client";

import { appendMovement } from "./inventory-movement.repository";
import { recordCommand } from "./operational-command.repository";

/** El lote no existe: no hay nada que derivar. */
export class LotNotFoundError extends Error {
  constructor(public readonly lotId: string) {
    super(`lot ${lotId} was not found`);
    this.name = "LotNotFoundError";
  }
}

/** El movimiento físico dejaría el estante en negativo. */
export class InsufficientStockError extends Error {
  constructor(
    public readonly lotId: string,
    public readonly onHand: number,
    public readonly quantityDelta: number,
  ) {
    super(`lot ${lotId} holds ${onHand}, cannot apply ${quantityDelta}`);
    this.name = "InsufficientStockError";
  }
}

/** Hay unidades, pero están comprometidas con otro. */
export class InsufficientAvailableError extends Error {
  constructor(
    public readonly lotId: string,
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(`lot ${lotId} has ${available} available, ${requested} requested`);
    this.name = "InsufficientAvailableError";
  }
}

/** Se libera más de lo que se había comprometido. */
export class ReleaseExceedsReservedError extends Error {
  constructor(
    public readonly lotId: string,
    public readonly activeReserved: number,
    public readonly released: number,
  ) {
    super(`lot ${lotId} has ${activeReserved} reserved, cannot release ${released}`);
    this.name = "ReleaseExceedsReservedError";
  }
}

const PHYSICAL_TYPES = [
  "RECEIPT",
  "DELIVERY",
  "ADJUSTMENT",
  "RETURN",
  "EXPIRY",
] as const satisfies readonly InventoryMovementType[];

const COMMITMENT_TYPES = [
  "RESERVATION",
  "RELEASE",
] as const satisfies readonly InventoryMovementType[];

// El signo es parte del hecho asentado, no una convención del llamador. Una
// liberación guardada en positivo sumaría a lo comprometido en lugar de
// restarlo: la cuenta saldría mal sin que nada falle.
const REQUIRED_SIGN: Record<InventoryMovementType, "positive" | "negative" | "either"> = {
  RECEIPT: "positive",
  RETURN: "positive",
  RESERVATION: "positive",
  DELIVERY: "negative",
  EXPIRY: "negative",
  RELEASE: "negative",
  ADJUSTMENT: "either",
};

function isPhysical(type: InventoryMovementType): boolean {
  return (PHYSICAL_TYPES as readonly InventoryMovementType[]).includes(type);
}

function assertSignedDelta(type: InventoryMovementType, quantityDelta: number): void {
  if (!Number.isInteger(quantityDelta) || quantityDelta === 0) {
    throw new RangeError(
      `quantityDelta must be a non-zero integer, received ${quantityDelta}`,
    );
  }

  const required = REQUIRED_SIGN[type];
  if (required === "positive" && quantityDelta < 0) {
    throw new RangeError(`${type} must carry a positive delta, received ${quantityDelta}`);
  }
  if (required === "negative" && quantityDelta > 0) {
    throw new RangeError(`${type} must carry a negative delta, received ${quantityDelta}`);
  }
}

async function sumQuantity(
  lotId: string,
  types: readonly InventoryMovementType[],
  client: Prisma.TransactionClient,
): Promise<number> {
  const { _sum } = await client.inventoryMovement.aggregate({
    _sum: { quantity: true },
    where: { lotId, type: { in: [...types] } },
  });
  return _sum.quantity ?? 0;
}

/**
 * Lo comprometido: reservas menos liberaciones, según el ledger.
 *
 * Las liberaciones se asientan con delta negativo, así que la resta ya viene en
 * el signo de cada movimiento y acá alcanza con sumar.
 */
export function computeActiveReserved(
  lotId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<number> {
  return sumQuantity(lotId, COMMITMENT_TYPES, client);
}

/** El stock que el ledger explica, contra el que se contrasta la columna. */
export function computeLedgerOnHand(
  lotId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<number> {
  return sumQuantity(lotId, PHYSICAL_TYPES, client);
}

/** Lo que hay menos lo comprometido. Una resta: no consulta nada. */
export function computeAvailable(onHand: number, activeReserved: number): number {
  return onHand - activeReserved;
}

export type ConservationReport = {
  /** La columna `lots.onHand`. */
  onHand: number;
  /** Lo que suman los movimientos físicos del ledger. */
  ledgerOnHand: number;
  activeReserved: number;
  available: number;
  valid: boolean;
};

/**
 * Contrasta la proyección contra el ledger y devuelve las tres cantidades.
 *
 * `valid` compara la columna con el ledger, y no `onHand` con
 * `available + activeReserved`: eso último es cierto por definición —
 * `available` se calcula restando— y no detectaría nada. Lo que sí puede
 * romperse es que la columna se separe de la historia que debería explicarla,
 * que es exactamente lo que el cutover tiene que reconciliar en los lotes
 * anteriores al ledger.
 */
export async function verifyConservationInvariant(
  lotId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<ConservationReport> {
  const lot = await client.lot.findUnique({ where: { id: lotId }, select: { onHand: true } });
  if (!lot) throw new LotNotFoundError(lotId);

  const ledgerOnHand = await computeLedgerOnHand(lotId, client);
  const activeReserved = await computeActiveReserved(lotId, client);
  const available = computeAvailable(lot.onHand, activeReserved);

  return {
    onHand: lot.onHand,
    ledgerOnHand,
    activeReserved,
    available,
    valid: lot.onHand === ledgerOnHand && activeReserved >= 0 && available >= 0,
  };
}

export type ApplyQuantitiesData = {
  lotId: string;
  actorId: string;
  commandType: string;
  /** Clave de idempotencia del llamador: UUIDv4. */
  commandKey: string;
  /** Delta firmado; el signo tiene que corresponder al tipo. */
  quantityDelta: number;
  moveType: InventoryMovementType;
};

export type AppliedQuantities = {
  movementId: string;
  newOnHand: number;
  newActiveReserved: number;
  available: number;
  /** La columna sigue explicada por el ledger después de aplicar. */
  conserved: boolean;
};

/**
 * Asienta un movimiento y deja las cantidades del lote consistentes.
 *
 * `client` es obligatorio y tiene que ser una transacción: el lock de fila que
 * toma acá abajo solo sirve mientras esa transacción viva. Con el cliente suelto
 * el lock se libera al instante y dos reservas simultáneas venden la misma
 * unidad — que es exactamente lo que esta función existe para impedir.
 *
 * Un reintento con la misma clave choca contra la identidad del comando y aborta
 * sin duplicar el efecto; devolver el resultado guardado es trabajo de la capa
 * de comandos, que es la que sabe qué significa repetir cada flujo.
 */
export async function computeAndApplyQuantities(
  data: ApplyQuantitiesData,
  client: Prisma.TransactionClient,
): Promise<AppliedQuantities> {
  const { lotId, quantityDelta, moveType } = data;
  assertSignedDelta(moveType, quantityDelta);

  // FOR UPDATE serializa a los que tocan ESTE lote y deja pasar al resto. Es lo
  // que hace que el disponible que leemos abajo siga siendo cierto cuando
  // escribimos: sin el lock, dos transacciones leen el mismo número viejo.
  const locked = await client.$queryRaw<{ productId: string; onHand: number }[]>`
    SELECT "productId", "onHand" FROM "lots" WHERE "id" = ${lotId} FOR UPDATE
  `;
  const lot = locked.at(0);
  if (!lot) throw new LotNotFoundError(lotId);

  const activeReserved = await computeActiveReserved(lotId, client);
  const physical = isPhysical(moveType);
  const prospectiveOnHand = physical ? lot.onHand + quantityDelta : lot.onHand;
  const prospectiveReserved = physical ? activeReserved : activeReserved + quantityDelta;

  if (prospectiveOnHand < 0) {
    throw new InsufficientStockError(lotId, lot.onHand, quantityDelta);
  }
  if (prospectiveReserved < 0) {
    throw new ReleaseExceedsReservedError(lotId, activeReserved, quantityDelta);
  }
  // Sacar del estante algo prometido a otro rompe la promesa igual que
  // sobre-reservar. Para entregar lo reservado, primero se libera.
  if (computeAvailable(prospectiveOnHand, prospectiveReserved) < 0) {
    throw new InsufficientAvailableError(
      lotId,
      computeAvailable(lot.onHand, activeReserved),
      quantityDelta,
    );
  }

  if (physical) {
    // El WHERE repite la condición que ya verificamos: es la defensa que
    // sobrevive si alguien llama a esto sin el lock. `count === 0` significa
    // que la fila cambió debajo nuestro.
    const { count } = await client.lot.updateMany({
      where: { id: lotId, onHand: { gte: -quantityDelta } },
      data: { onHand: { increment: quantityDelta } },
    });
    if (count === 0) {
      throw new InsufficientStockError(lotId, lot.onHand, quantityDelta);
    }
  }

  // El comando primero: el movimiento lo referencia con una FK obligatoria, así
  // que tiene que existir antes. Por eso su `result` no puede nombrar al
  // movimiento, que todavía no fue asentado.
  const command = await recordCommand(
    {
      actorId: data.actorId,
      commandType: data.commandType,
      commandKey: data.commandKey,
      fingerprint: fingerprintOf({ lotId, moveType, quantityDelta }),
      result: { lotId, moveType, quantityDelta },
    },
    client,
  );

  const movement = await appendMovement(
    {
      lotId,
      productId: lot.productId,
      type: moveType,
      quantity: quantityDelta,
      actorId: data.actorId,
      commandId: command.id,
    },
    client,
  );

  // Los números que se devuelven salen del ledger ya con el asiento adentro, no
  // de la aritmética de arriba: si las dos cuentas discreparan, la que vale es
  // la del ledger y `conserved` lo delata.
  const ledgerOnHand = await computeLedgerOnHand(lotId, client);
  const newActiveReserved = await computeActiveReserved(lotId, client);

  return {
    movementId: movement.id,
    newOnHand: prospectiveOnHand,
    newActiveReserved,
    available: computeAvailable(prospectiveOnHand, newActiveReserved),
    conserved: prospectiveOnHand === ledgerOnHand,
  };
}

/** SHA-256 del payload canónico: ata la clave de idempotencia al contenido. */
function fingerprintOf(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

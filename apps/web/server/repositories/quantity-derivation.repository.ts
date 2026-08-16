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
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { InventoryMovementType, Prisma } from "@/lib/generated/prisma/client";

/** El lote no existe: no hay nada que derivar. */
export class LotNotFoundError extends Error {
  constructor(public readonly lotId: string) {
    super(`lot ${lotId} was not found`);
    this.name = "LotNotFoundError";
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

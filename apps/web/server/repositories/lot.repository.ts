// --------------------------------------------------------------------------
// Repositorio de lotes del modelo canónico — ÚNICO lugar que toca Prisma para
// `Lot`.
//
// Convive con `product-batch.repository.ts`, que es el legado y sigue en uso
// hasta el cutover. Este archivo NO lee ni escribe `ProductBatch`.
//
// Acá NO se mueven cantidades. Sumar y restar `onHand` llega con el ledger de
// movimientos (T1.3), que es quien deja el rastro de por qué cambió: una
// mutación suelta sin asiento sería stock sin explicación.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { Lot, LotStatus, Prisma } from "@/lib/generated/prisma/client";

/**
 * El par (producto, número de lote) ya existe.
 *
 * NO se reintenta: no es una colisión de un valor que generamos nosotros, es
 * un conflicto real con lo que alguien cargó antes. Reintentar solo crearía
 * otro lote con otro número y taparía el problema; quien llama decide si está
 * recibiendo mercadería de un lote ya registrado.
 */
export class LotIdentityConflictError extends Error {
  constructor(
    public readonly productId: string,
    public readonly lotNumber: string,
  ) {
    super(`lot ${lotNumber} already exists for product ${productId}`);
    this.name = "LotIdentityConflictError";
  }
}

export type CreateLotData = {
  productId: string;
  lotNumber: string;
  /** Nulo = sin vencimiento. FEFO lo ordena al final. */
  expiresAt?: Date | null;
  onHand: number;
  receivedAt?: Date;
  status?: LotStatus;
  location?: string | null;
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Crea el lote. La cantidad se valida antes de escribir para dar un error
 * legible, pero la garantía real la sostiene el CHECK de la base: si algún día
 * otra ruta escribe sin pasar por acá, sigue sin poder dejar stock negativo.
 */
export async function createLot(
  data: CreateLotData,
  client: Prisma.TransactionClient = prisma,
): Promise<Lot> {
  if (!Number.isInteger(data.onHand) || data.onHand < 0) {
    throw new RangeError(`onHand must be a non-negative integer, received ${data.onHand}`);
  }

  try {
    return await client.lot.create({
      data: {
        productId: data.productId,
        lotNumber: data.lotNumber,
        expiresAt: data.expiresAt ?? null,
        onHand: data.onHand,
        ...(data.receivedAt ? { receivedAt: data.receivedAt } : {}),
        ...(data.status ? { status: data.status } : {}),
        location: data.location ?? null,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new LotIdentityConflictError(data.productId, data.lotNumber);
    }
    throw error;
  }
}

export function findLotById(
  id: string,
  client: Prisma.TransactionClient = prisma,
): Promise<Lot | null> {
  return client.lot.findUnique({ where: { id } });
}

/**
 * Lotes que se pueden consumir de un producto en el instante `at`, en orden
 * FEFO: primero vence, primero sale.
 *
 * El vencimiento se deriva acá y no se guarda: el mismo lote es elegible antes
 * de su fecha y deja de serlo después, sin que nadie tenga que correr un
 * proceso que actualice estados.
 *
 * El orden es `(expiresAt null-last, expiresAt, receivedAt, id)`. Los NULL van
 * al final porque "sin vencimiento" no es "vence ya", y el desempate por
 * recepción e id hace que el orden sea estable entre corridas —condición para
 * poder paginarlo y para que una reserva sea reproducible.
 */
export function listEligibleLots(
  productId: string,
  at: Date,
  client: Prisma.TransactionClient = prisma,
): Promise<Lot[]> {
  return client.lot.findMany({
    where: {
      productId,
      status: "AVAILABLE",
      OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
    },
    orderBy: [
      { expiresAt: { sort: "asc", nulls: "last" } },
      { receivedAt: "asc" },
      { id: "asc" },
    ],
  });
}

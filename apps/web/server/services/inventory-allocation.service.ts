// --------------------------------------------------------------------------
// Reparto de inventario canónico (P2 · contabilidad).
//
// Compone las tres piezas que ya existían y no se hablaban:
//   T1.2  qué lotes se pueden usar y en qué orden (FEFO)
//   T2.1  cómo se reparte una cantidad entre ellos (planificador puro)
//   T1.4  cómo se mueve UN lote sin romper los invariantes
//
// PLANIFICAR Y APLICAR ESTÁN SEPARADOS A PROPÓSITO.
//
// El ledger admite UN asiento por comando (`@@unique([commandId])` de T1.3), así
// que una reserva que cruza tres lotes son tres comandos. Para que un reintento
// no comprometa seis veces, cada línea necesita SU clave de idempotencia — y
// para eso hay que saber cuántas líneas hay ANTES de aplicar. Por eso el que
// pide planifica primero, ve el plan, y entrega una clave por línea. Derivar las
// claves acá obligaría a inventar UUIDs con forma de v4, y relajar el validador
// del command store tocaría algo que ya está probado y mergeado.
//
// El plan se arma LEYENDO, sin lock. Entre planificar y aplicar, otro puede
// haberse llevado el stock. No es un problema: el aplicador toma el lock por
// lote y vuelve a mirar, así que un plan viejo se cae entero en vez de
// comprometer de más. El plan es una intención, no una promesa.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@/lib/generated/prisma/client";
import {
  planFefoAllocation,
  type AllocationPlan,
} from "@/server/domain/inventory/fefo-allocation";
import { listEligibleLots } from "@/server/repositories/lot.repository";
import {
  CommandAlreadyRecordedError,
  findCommand,
} from "@/server/repositories/operational-command.repository";
import {
  computeActiveReserved,
  computeAndApplyQuantities,
  verifyConservationInvariant,
} from "@/server/repositories/quantity-derivation.repository";

/** Dos reintentos a la vez: el otro ganó la carrera y ya asentó esta línea. */
export class AllocationAlreadyAppliedError extends Error {
  constructor(public readonly commandKey: string) {
    super(`allocation with command key ${commandKey} was already applied`);
    this.name = "AllocationAlreadyAppliedError";
  }
}

/** La clave ya se usó para OTRA línea: repetirla acá taparía un movimiento. */
export class AllocationKeyReusedError extends Error {
  constructor(public readonly commandKey: string) {
    super(`command key ${commandKey} was already used for a different allocation line`);
    this.name = "AllocationKeyReusedError";
  }
}

/**
 * Arma el plan FEFO para un producto.
 *
 * `available` sale del ledger por lote —lo que hay menos lo ya comprometido—,
 * no de la columna sola: comprometer dos veces la misma unidad es exactamente
 * lo que hay que impedir.
 */
export async function planProductReservation(
  params: { productId: string; quantity: number; at?: Date },
  client: Prisma.TransactionClient = prisma,
): Promise<AllocationPlan> {
  const at = params.at ?? new Date();
  const lots = await listEligibleLots(params.productId, at, client);

  const allocatable = [];
  for (const lot of lots) {
    const activeReserved = await computeActiveReserved(lot.id, client);
    allocatable.push({ id: lot.id, available: lot.onHand - activeReserved });
  }

  return planFefoAllocation(allocatable, params.quantity);
}

type ApplyParams = {
  plan: AllocationPlan;
  actorId: string;
  commandType: string;
  /** Una clave UUIDv4 por línea del plan, en el mismo orden. */
  commandKeys: string[];
};

export type AppliedLine = {
  lotId: string;
  movementId: string;
  available: number;
};

/** Compromete el plan: baja lo disponible y deja el estante como estaba. */
export function reserveAllocation(
  params: ApplyParams,
  client: Prisma.TransactionClient,
): Promise<AppliedLine[]> {
  return applyLines(params, "RESERVATION", 1, client);
}

/** Suelta lo comprometido. El stock no se mueve: nunca salió del estante. */
export function releaseAllocation(
  params: ApplyParams,
  client: Prisma.TransactionClient,
): Promise<AppliedLine[]> {
  return applyLines(params, "RELEASE", -1, client);
}

/**
 * Entrega lo reservado: suelta la promesa y saca la unidad.
 *
 * Son dos asientos por lote y en ESTE orden. Sacar primero fallaría contra la
 * guarda de T1.4 —esas unidades están prometidas—, y saltearse la liberación
 * dejaría el compromiso vivo sobre stock que ya no está.
 */
export async function deliverAllocation(
  params: {
    plan: AllocationPlan;
    actorId: string;
    commandType: string;
    releaseKeys: string[];
    deliveryKeys: string[];
  },
  client: Prisma.TransactionClient,
): Promise<AppliedLine[]> {
  await applyLines(
    {
      plan: params.plan,
      actorId: params.actorId,
      commandType: `${params.commandType}.release`,
      commandKeys: params.releaseKeys,
    },
    "RELEASE",
    -1,
    client,
  );

  return applyLines(
    {
      plan: params.plan,
      actorId: params.actorId,
      commandType: params.commandType,
      commandKeys: params.deliveryKeys,
    },
    "DELIVERY",
    -1,
    client,
  );
}

async function applyLines(
  params: ApplyParams,
  moveType: "RESERVATION" | "RELEASE" | "DELIVERY",
  sign: 1 | -1,
  client: Prisma.TransactionClient,
): Promise<AppliedLine[]> {
  const { lines } = params.plan;

  // Una clave por línea, ni una más ni una menos. Con menos, alguna línea se
  // quedaría sin identidad y un reintento la duplicaría; con más, el llamador
  // está contando otra cosa y conviene que se entere ahora.
  if (params.commandKeys.length !== lines.length) {
    throw new RangeError(
      `expected ${lines.length} command keys for the plan, received ${params.commandKeys.length}`,
    );
  }

  const applied: AppliedLine[] = [];

  for (const [index, line] of lines.entries()) {
    const commandKey = params.commandKeys[index]!;

    // Identidad ANTES que guardas. Un reintento encuentra su propio comando ya
    // asentado y devuelve lo que pasó, en vez de volver a chocar contra una
    // guarda que ahora dice otra cosa: después de entregar, repetir la
    // liberación parece "liberás más de lo que reservaste", cuando en realidad
    // es "esto ya lo hiciste". El efecto no se duplica de las dos formas, pero
    // solo una de las dos le dice la verdad al llamador.
    const known = await findCommand(
      { actorId: params.actorId, commandType: params.commandType, commandKey },
      client,
    );
    if (known) {
      const movement = await client.inventoryMovement.findUnique({
        where: { commandId: known.id },
      });
      // Misma clave para otra línea: si lo dejáramos pasar en silencio, esa
      // línea nunca se asentaría y el reparto quedaría corto sin que nada falle.
      if (
        !movement ||
        movement.lotId !== line.lotId ||
        movement.type !== moveType ||
        movement.quantity !== line.quantity * sign
      ) {
        throw new AllocationKeyReusedError(commandKey);
      }

      const estado = await verifyConservationInvariant(line.lotId, client);
      applied.push({
        lotId: line.lotId,
        movementId: movement.id,
        available: estado.available,
      });
      continue;
    }

    try {
      const result = await computeAndApplyQuantities(
        {
          lotId: line.lotId,
          actorId: params.actorId,
          commandType: params.commandType,
          commandKey,
          quantityDelta: line.quantity * sign,
          moveType,
        },
        client,
      );
      applied.push({
        lotId: line.lotId,
        movementId: result.movementId,
        available: result.available,
      });
    } catch (error) {
      // La identidad del comando ya existía: este reparto se aplicó antes. El
      // efecto NO se duplica —lo impide el store, no un flag nuestro—; acá solo
      // se le pone nombre para que el llamador lo distinga de un fallo real.
      if (error instanceof CommandAlreadyRecordedError) {
        throw new AllocationAlreadyAppliedError(commandKey);
      }
      throw error;
    }
  }

  return applied;
}

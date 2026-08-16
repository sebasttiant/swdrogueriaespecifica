// --------------------------------------------------------------------------
// Store de comandos — ÚNICO lugar que toca Prisma para `OperationalCommand`.
//
// Es lo que hace que un reintento no duplique un efecto. Un comando se
// identifica por (actor, tipo, clave), y esa identidad incluye al actor a
// propósito: un comando ajeno no se lee, y por lo tanto tampoco se puede
// replicar. La clave sola no alcanza — si alcanzara, otro usuario podría
// reclamar el resultado de una operación que no ejecutó.
//
// El store no sabe qué comandos existen: `commandType` es String libre. La
// lista de comandos del negocio crece con cada flujo, y acoplarla acá
// obligaría a una migración por cada uno.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { OperationalCommand, Prisma } from "@/lib/generated/prisma/client";

/** Misma clave de comando, contenido distinto: es un error del llamador. */
export class CommandPayloadConflictError extends Error {
  constructor(
    public readonly actorId: string,
    public readonly commandType: string,
    public readonly commandKey: string,
  ) {
    super(`command ${commandType}/${commandKey} was already used with a different payload`);
    this.name = "CommandPayloadConflictError";
  }
}

/** El comando ya estaba registrado para ese actor, tipo y clave. */
export class CommandAlreadyRecordedError extends Error {
  constructor(
    public readonly actorId: string,
    public readonly commandType: string,
    public readonly commandKey: string,
  ) {
    super(`command ${commandType}/${commandKey} was already recorded`);
    this.name = "CommandAlreadyRecordedError";
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Normaliza la clave a minúsculas y valida que sea UUIDv4.
 *
 * Sin normalizar, la misma clave escrita en mayúsculas crearía un segundo
 * comando y el reintento duplicaría el efecto — que es exactamente lo que este
 * store existe para impedir.
 */
export function normalizeCommandKey(commandKey: string): string {
  const normalized = commandKey.trim().toLowerCase();

  if (!UUID_V4.test(normalized)) {
    throw new RangeError(`commandKey must be a UUIDv4, received "${commandKey}"`);
  }

  return normalized;
}

export type CommandIdentity = {
  actorId: string;
  commandType: string;
  commandKey: string;
};

export type RecordCommandData = CommandIdentity & {
  fingerprint: string;
  result?: Prisma.InputJsonValue;
  error?: Prisma.InputJsonValue;
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/** El registro del comando, o null. La consulta SIEMPRE lleva el actor. */
export function findCommand(
  identity: CommandIdentity,
  client: Prisma.TransactionClient = prisma,
): Promise<OperationalCommand | null> {
  return client.operationalCommand.findUnique({
    where: {
      actorId_commandType_commandKey: {
        actorId: identity.actorId,
        commandType: identity.commandType,
        commandKey: normalizeCommandKey(identity.commandKey),
      },
    },
  });
}

/**
 * Deja asentado que el comando terminó, con su resultado o con su error.
 *
 * Se escribe DESPUÉS del efecto y en la misma transacción: un comando guardado
 * antes de que el efecto ocurra prometería un resultado que todavía no existe.
 */
export async function recordCommand(
  data: RecordCommandData,
  client: Prisma.TransactionClient = prisma,
): Promise<OperationalCommand> {
  const commandKey = normalizeCommandKey(data.commandKey);

  try {
    return await client.operationalCommand.create({
      data: {
        actorId: data.actorId,
        commandType: data.commandType,
        commandKey,
        fingerprint: data.fingerprint,
        ...(data.result === undefined ? {} : { result: data.result }),
        ...(data.error === undefined ? {} : { error: data.error }),
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CommandAlreadyRecordedError(data.actorId, data.commandType, commandKey);
    }
    throw error;
  }
}

export type CommandIdempotency =
  | { status: "new" }
  | {
      status: "replay";
      result: Prisma.JsonValue | null;
      error: Prisma.JsonValue | null;
    };

/**
 * Decide qué hacer con un comando que llega: ejecutarlo o devolver lo que ya
 * pasó.
 *
 * Para otro actor el comando es siempre nuevo, porque no ve el ajeno.
 */
export async function resolveCommandIdempotency(
  identity: CommandIdentity & { fingerprint: string },
  client: Prisma.TransactionClient = prisma,
): Promise<CommandIdempotency> {
  const known = await findCommand(identity, client);
  if (!known) return { status: "new" };

  if (known.fingerprint !== identity.fingerprint) {
    throw new CommandPayloadConflictError(
      identity.actorId,
      identity.commandType,
      normalizeCommandKey(identity.commandKey),
    );
  }

  return { status: "replay", result: known.result, error: known.error };
}

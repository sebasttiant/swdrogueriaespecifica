import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  CommandPayloadConflictError,
  findCommand,
  recordCommand,
  resolveCommandIdempotency,
} from "@/server/repositories/operational-command.repository";

// El store de comandos es lo que hace que un reintento no duplique un efecto.
// Se prueba contra PostgreSQL real porque lo que garantiza la unicidad es el
// índice de la base: entre consultar y escribir se mete el otro intento.

const ACTOR = "actor-uno";
const OTHER_ACTOR = "actor-dos";
const TYPE = "inventory.delivery";

const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

afterEach(async () => {
  await prisma.operationalCommand.deleteMany({
    where: { actorId: { in: [ACTOR, OTHER_ACTOR] } },
  });
});

describe("recordCommand y findCommand", () => {
  it("guarda el comando con su resultado y lo devuelve al mismo actor", async () => {
    const commandKey = randomUUID();
    const recorded = await recordCommand({
      actorId: ACTOR,
      commandType: TYPE,
      commandKey,
      fingerprint: FINGERPRINT_A,
      result: { deliveredQuantity: 3 },
    });

    const found = await findCommand({ actorId: ACTOR, commandType: TYPE, commandKey });

    expect(found?.id).toBe(recorded.id);
    expect(found?.result).toEqual({ deliveredQuantity: 3 });
    expect(found?.error).toBeNull();
  });

  it("guarda un comando que terminó en error tipado", async () => {
    const commandKey = randomUUID();
    await recordCommand({
      actorId: ACTOR,
      commandType: TYPE,
      commandKey,
      fingerprint: FINGERPRINT_A,
      error: { code: "INSUFFICIENT_STOCK" },
    });

    const found = await findCommand({ actorId: ACTOR, commandType: TYPE, commandKey });

    expect(found?.error).toEqual({ code: "INSUFFICIENT_STOCK" });
    expect(found?.result).toBeNull();
  });

  // La identidad del comando incluye al actor: un comando ajeno no se lee, y
  // por lo tanto tampoco se puede replicar.
  it("no le muestra el comando a otro actor", async () => {
    const commandKey = randomUUID();
    await recordCommand({
      actorId: ACTOR,
      commandType: TYPE,
      commandKey,
      fingerprint: FINGERPRINT_A,
      result: { ok: true },
    });

    expect(
      await findCommand({ actorId: OTHER_ACTOR, commandType: TYPE, commandKey }),
    ).toBeNull();
  });

  // La clave la genera el llamador; el store la normaliza para que la misma
  // clave escrita distinto no cree dos comandos.
  it("trata la misma clave en mayúsculas como la misma", async () => {
    const commandKey = randomUUID();
    await recordCommand({
      actorId: ACTOR,
      commandType: TYPE,
      commandKey: commandKey.toUpperCase(),
      fingerprint: FINGERPRINT_A,
      result: { ok: true },
    });

    const found = await findCommand({ actorId: ACTOR, commandType: TYPE, commandKey });

    expect(found?.commandKey).toBe(commandKey);
  });

  it("rechaza una clave que no es UUIDv4", async () => {
    for (const commandKey of ["no-es-uuid", "", randomUUID().slice(0, 20)]) {
      await expect(
        recordCommand({
          actorId: ACTOR,
          commandType: TYPE,
          commandKey,
          fingerprint: FINGERPRINT_A,
          result: { ok: true },
        }),
      ).rejects.toThrow();
    }
  });

  // Un comando sin resultado ni error no terminó: guardarlo dejaría un registro
  // que no se puede replicar. Lo sostiene la BASE, no solo el repositorio.
  it("la base exige que el comando tenga resultado o error", async () => {
    const failure = await prisma.operationalCommand
      .create({
        data: {
          actorId: ACTOR,
          commandType: TYPE,
          commandKey: randomUUID(),
          fingerprint: FINGERPRINT_A,
        },
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
  });
});

describe("resolveCommandIdempotency", () => {
  const identity = () => ({
    actorId: ACTOR,
    commandType: TYPE,
    commandKey: randomUUID(),
  });

  it("un comando que nunca corrió es nuevo", async () => {
    expect(
      await resolveCommandIdempotency({ ...identity(), fingerprint: FINGERPRINT_A }),
    ).toEqual({ status: "new" });
  });

  // El operador que reintenta recibe el resultado guardado, no un efecto nuevo.
  it("el mismo pedido devuelve el resultado guardado", async () => {
    const command = identity();
    await recordCommand({
      ...command,
      fingerprint: FINGERPRINT_A,
      result: { deliveredQuantity: 3 },
    });

    expect(
      await resolveCommandIdempotency({ ...command, fingerprint: FINGERPRINT_A }),
    ).toEqual({
      status: "replay",
      result: { deliveredQuantity: 3 },
      error: null,
    });
  });

  it("replica también el error guardado", async () => {
    const command = identity();
    await recordCommand({
      ...command,
      fingerprint: FINGERPRINT_A,
      error: { code: "INSUFFICIENT_STOCK" },
    });

    expect(
      await resolveCommandIdempotency({ ...command, fingerprint: FINGERPRINT_A }),
    ).toEqual({
      status: "replay",
      result: null,
      error: { code: "INSUFFICIENT_STOCK" },
    });
  });

  // Misma clave con otro contenido no es un reintento: es un error del
  // llamador. Devolverle el resultado anterior lo dejaría creyendo que pasó
  // algo que nunca pasó.
  it("rechaza la misma clave con otro contenido", async () => {
    const command = identity();
    await recordCommand({
      ...command,
      fingerprint: FINGERPRINT_A,
      result: { deliveredQuantity: 3 },
    });

    await expect(
      resolveCommandIdempotency({ ...command, fingerprint: FINGERPRINT_B }),
    ).rejects.toBeInstanceOf(CommandPayloadConflictError);
  });

  // Otro actor con la misma clave arranca de cero: no ve el comando ajeno, y
  // tampoco puede replicarlo.
  it("para otro actor el mismo comando es nuevo", async () => {
    const command = identity();
    await recordCommand({
      ...command,
      fingerprint: FINGERPRINT_A,
      result: { ok: true },
    });

    expect(
      await resolveCommandIdempotency({
        ...command,
        actorId: OTHER_ACTOR,
        fingerprint: FINGERPRINT_B,
      }),
    ).toEqual({ status: "new" });
  });
});

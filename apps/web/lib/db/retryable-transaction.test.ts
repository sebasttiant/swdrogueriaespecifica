import { describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { $transaction: vi.fn() },
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import {
  isRetryableTransactionError,
  withRetryableTransaction,
} from "./retryable-transaction";

// Las tres formas en que llega un aborto reintentable de PostgreSQL a través de
// Prisma 7 con el adapter de `pg`: el código conocido de Prisma, el SQLSTATE
// crudo en `code`, y el SQLSTATE embebido en el mensaje cuando el error sube
// como `PrismaClientUnknownRequestError`.
function prismaWriteConflict() {
  return Object.assign(new Error("Transaction failed due to a write conflict or a deadlock"), {
    code: "P2034",
  });
}
function rawDeadlock() {
  return Object.assign(new Error("deadlock detected"), { code: "40P01" });
}
function unknownWrappedSerializationFailure() {
  return new Error(
    "Invalid `prisma.pending.update()` invocation: could not serialize access due to concurrent update (SQLSTATE 40001)",
  );
}

function alwaysRunsCallback() {
  prismaMock.$transaction.mockImplementation(
    (fn: (client: unknown) => unknown) => fn({ marker: "tx" }),
  );
}

describe("isRetryableTransactionError", () => {
  it("acepta SOLO los abortos que PostgreSQL garantiza que no dejaron nada escrito", () => {
    expect(isRetryableTransactionError(prismaWriteConflict())).toBe(true);
    expect(isRetryableTransactionError(rawDeadlock())).toBe(true);
    expect(isRetryableTransactionError(unknownWrappedSerializationFailure())).toBe(true);
  });

  // ESTA es la mitad importante. Un reintento genérico vuelve a correr una
  // operación que quizá SÍ escribió, o que falló por una regla de negocio que
  // no va a cambiar sola: duplicaría entregas o giraría en falso hasta agotar
  // los intentos. Solo 40001/40P01/P2034 abortan la transacción entera y son
  // seguros de repetir.
  it("rechaza cualquier otro error, incluidos los que parecen transitorios", () => {
    expect(isRetryableTransactionError(new Error("Pending not found"))).toBe(false);
    expect(
      isRetryableTransactionError(Object.assign(new Error("unique"), { code: "P2002" })),
    ).toBe(false);
    expect(
      isRetryableTransactionError(Object.assign(new Error("timeout"), { code: "P2024" })),
    ).toBe(false);
    // `55P03` (lock_not_available) NO es reintentable acá: lo produce el
    // `lock_timeout`, y repetirlo solo alarga la espera del operador.
    expect(
      isRetryableTransactionError(Object.assign(new Error("lock"), { code: "55P03" })),
    ).toBe(false);
    expect(isRetryableTransactionError("40P01")).toBe(false);
    expect(isRetryableTransactionError(null)).toBe(false);
  });

  it("no confunde un 40001 que aparezca dentro de un dato de negocio", () => {
    expect(isRetryableTransactionError(new Error("lote 40001 vencido"))).toBe(false);
  });
});

describe("withRetryableTransaction", () => {
  it("no reintenta nada cuando la transacción sale bien a la primera", async () => {
    alwaysRunsCallback();
    const run = vi.fn().mockResolvedValue("ok");

    await expect(withRetryableTransaction(run)).resolves.toBe("ok");

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ marker: "tx" });
  });

  it("reintenta un deadlock y devuelve el resultado del intento que sí pasa", async () => {
    alwaysRunsCallback();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const run = vi
      .fn()
      .mockRejectedValueOnce(rawDeadlock())
      .mockResolvedValue("recuperado");

    await expect(withRetryableTransaction(run, { sleep, jitter: () => 0 })).resolves.toBe(
      "recuperado",
    );

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("espera con backoff creciente entre intentos, no en bucle cerrado", async () => {
    alwaysRunsCallback();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const run = vi
      .fn()
      .mockRejectedValueOnce(rawDeadlock())
      .mockRejectedValueOnce(prismaWriteConflict())
      .mockResolvedValue("ok");

    await withRetryableTransaction(run, { baseDelayMs: 20, sleep, jitter: () => 0 });

    // Dos esperas para tres intentos, y la segunda más larga que la primera:
    // dos transacciones que chocaron y reintentan al mismo ritmo se vuelven a
    // encontrar. El backoff las separa.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([20, 40]);
  });

  it("el jitter separa dos reintentos que arrancaron a la vez", async () => {
    alwaysRunsCallback();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockRejectedValueOnce(rawDeadlock()).mockResolvedValue("ok");

    await withRetryableTransaction(run, { baseDelayMs: 20, sleep, jitter: () => 1 });

    expect(sleep).toHaveBeenCalledWith(30); // 20 + jitter completo (50% de 20)
  });

  // LÍMITE EXPLÍCITO: sin él un deadlock persistente deja la petición colgada y
  // consumiendo una conexión del pool, que es peor que fallar.
  it("agota el límite y propaga el ÚLTIMO error, sin envolverlo", async () => {
    alwaysRunsCallback();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const last = prismaWriteConflict();
    const run = vi
      .fn()
      .mockRejectedValueOnce(rawDeadlock())
      .mockRejectedValueOnce(rawDeadlock())
      .mockRejectedValueOnce(last);

    await expect(
      withRetryableTransaction(run, { maxAttempts: 3, sleep, jitter: () => 0 }),
    ).rejects.toBe(last);

    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("un error de negocio sube en el primer intento y NO se reintenta", async () => {
    alwaysRunsCallback();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const boom = new Error("Pending not found");
    const run = vi.fn().mockRejectedValue(boom);

    await expect(withRetryableTransaction(run, { sleep })).rejects.toBe(boom);

    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rechaza un maxAttempts inválido en vez de degradar a reintento infinito", async () => {
    alwaysRunsCallback();
    const run = vi.fn().mockResolvedValue("ok");

    await expect(withRetryableTransaction(run, { maxAttempts: 0 })).rejects.toThrow(
      /maxAttempts/,
    );
    expect(run).not.toHaveBeenCalled();
  });
});

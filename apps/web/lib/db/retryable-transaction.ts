// --------------------------------------------------------------------------
// Reintento ACOTADO de transacciones abortadas por PostgreSQL.
//
// POR QUÉ EXISTE. El orden global de locks de este sistema es
// `product_batches` → `pendings` → `missing_items`. Queda una ventana que no se
// puede cerrar ordenando: entre la lectura sin lock del ledger de reservas y el
// lock del pendiente, una entrada concurrente puede crear una reserva sobre un
// lote que no estaba en esa lectura. Esa liberación pediría ese lote
// sosteniendo el pendiente, y ahí sí hay ciclo.
//
// CÓMO SE USA. Es el envoltorio para las operaciones que pueden perder una
// carrera y no tienen forma de resolverla desde adentro. El caso concreto de
// hoy es el outbox de notificaciones: `enqueueOutboxEvent` lanza
// `NotificationEnqueueRaceError` en vez de intentar consultar sobre una
// transacción que PostgreSQL ya abortó, y quien lo llama repite la transacción
// entera —con una viva— para que la segunda vuelta encuentre el evento y
// resuelva si fue replay o conflicto.
//
// POR QUÉ ES SEGURO REINTENTAR, y solo acá. Los tres códigos de abajo tienen
// una propiedad que ningún otro error tiene: PostgreSQL ABORTA la transacción
// entera antes de devolverlos. No queda nada escrito, ni a medias. Repetir el
// callback es empezar de cero, no repetir un efecto.
//
// LO QUE ESTO NO ES: un reintento genérico. Un `catch` que reintenta cualquier
// error vuelve a correr operaciones que quizá sí escribieron —duplicando una
// entrega— o insiste contra una regla de negocio que no va a cambiar sola,
// gastando el límite y la conexión del pool. Por eso el filtro es una lista
// cerrada y el límite es explícito.
// --------------------------------------------------------------------------

import type { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db/prisma";

/**
 * `40001` serialization_failure · `40P01` deadlock_detected — SQLSTATE crudo,
 * tal como los emite PostgreSQL. `P2034` es cómo Prisma envuelve a los dos.
 *
 * `55P03` (lock_not_available, el que produce `lock_timeout`) queda AFUERA a
 * propósito: significa que otro sostiene el lock más de lo tolerado, y
 * reintentar solo alarga la espera del operador sin cambiar la causa.
 */
const RETRYABLE_CODES = new Set(["40001", "40P01", "P2034"]);

/**
 * Reconoce el SQLSTATE cuando el error sube como
 * `PrismaClientUnknownRequestError` y el código solo vive en el texto. El
 * `SQLSTATE ` de adelante es lo que evita confundirlo con un `40001` que sea
 * un dato de negocio dentro del mensaje.
 */
const SQLSTATE_IN_MESSAGE = /SQLSTATE\s+(40001|40P01)\b/;

export function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && RETRYABLE_CODES.has(code)) return true;

  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && SQLSTATE_IN_MESSAGE.test(message);
}

export type RetryableTransactionOptions = {
  /** Intentos TOTALES, no reintentos extra. Debe ser >= 1. */
  maxAttempts?: number;
  /** Espera del primer reintento; se duplica en cada uno siguiente. */
  baseDelayMs?: number;
  /** Inyectables para que los tests no dependan del reloj ni del azar. */
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 25;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Corre `run` dentro de una transacción interactiva y la repite SOLO si
 * PostgreSQL la abortó por deadlock o fallo de serialización.
 *
 * El backoff crece al doble en cada intento y lleva jitter: dos transacciones
 * que chocaron entre sí arrancaron a la vez, así que reintentar al mismo ritmo
 * las vuelve a poner en el mismo choque. El jitter las separa.
 *
 * Al agotar los intentos propaga el ÚLTIMO error tal cual, sin envolverlo: el
 * código real es lo que sirve para diagnosticar, y esconderlo detrás de un
 * error propio solo agrega ruido.
 */
export async function withRetryableTransaction<T>(
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  options: RetryableTransactionOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`withRetryableTransaction: maxAttempts debe ser un entero >= 1`);
  }
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction((tx) => run(tx as Prisma.TransactionClient));
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableTransactionError(error)) throw error;
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      await sleep(Math.round(backoff + jitter() * backoff * 0.5));
    }
  }
}

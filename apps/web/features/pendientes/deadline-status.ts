import type { PendingStatus } from "@/lib/generated/prisma/client";

// --------------------------------------------------------------------------
// Semáforo operativo del pendiente según su promesa de entrega.
//
// Función PURA: recibe `now` inyectable para ser determinista y testeable. No
// toca Prisma ni el reloj global salvo por el default. La UI sólo la consume.
// --------------------------------------------------------------------------

export type DeadlineStatus =
  | "VENCIDO"
  | "VENCE_PRONTO"
  | "A_TIEMPO"
  | "FINALIZADO";

// Ventana crítica: faltando 2 horas o menos para la promesa.
export const SOON_WINDOW_MS = 2 * 60 * 60 * 1000;

// Estados terminales: ya no hay nada operativo que vigilar. T2.2b: el cierre
// parcial también es terminal — la promesa se resolvió en el mostrador.
const FINAL_STATUSES: readonly PendingStatus[] = ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"];

export function computeDeadlineStatus(
  promisedAt: Date,
  status: PendingStatus,
  now: Date = new Date(),
): DeadlineStatus {
  if (FINAL_STATUSES.includes(status)) return "FINALIZADO";

  const remainingMs = promisedAt.getTime() - now.getTime();
  if (remainingMs < 0) return "VENCIDO";
  if (remainingMs <= SOON_WINDOW_MS) return "VENCE_PRONTO";
  return "A_TIEMPO";
}

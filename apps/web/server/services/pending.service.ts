// --------------------------------------------------------------------------
// Servicio de pendientes (server-only). Boundary de negocio del caso de uso
// "registrar un pendiente".
//
// Regla de Fase 2: un pendiente que no tiene stock vendible suficiente genera,
// en el mismo acto, un faltante por el DÉFICIT (no por la cantidad total).
// Esta lógica vive acá, nunca en la UI ni en la Server Action. La acción solo
// orquesta validación, permisos y auditoría sobre el resultado.
//
// No descuenta stock ni cambia estados: eso es de fases siguientes.
// --------------------------------------------------------------------------

import type { Pending, MissingItem } from "@/lib/generated/prisma/client";
import {
  countOpenPendings,
  countOverduePendings,
  countUpcomingPendings,
  createPending,
  listPendings,
  listUrgentPendings,
  type CreatePendingData,
  type PendingListItem,
} from "@/server/repositories/pending.repository";
import { createMissingItem } from "@/server/repositories/missing-item.repository";
import { stockByProduct } from "@/server/repositories/product-batch.repository";
import { prisma } from "@/lib/db/prisma";
import type { Paginated } from "@/lib/pagination";

/**
 * Faltante = solo el déficit. Nunca negativo: si el stock alcanza, es 0.
 * Función pura para que la regla quede explícita y aislada de Prisma.
 */
export function computeMissingQuantity(
  requestedQuantity: number,
  sellableStock: number,
): number {
  return Math.max(requestedQuantity - sellableStock, 0);
}

export type CreatePendingResult = {
  pending: Pending;
  // El faltante generado por déficit, o null si había stock suficiente.
  missingItem: MissingItem | null;
  sellableStock: number;
  missingQuantity: number;
};

export function getPendings(params: {
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<PendingListItem>> {
  return listPendings(params);
}

export type PendingDashboard = {
  openCount: number;
  overdueCount: number;
  upcomingCount: number; // Próximas: promisedAt within 24h, open
  urgent: PendingListItem[];
};

// Resumen para el dashboard: cuántos pendientes abiertos hay, cuántos vencidos,
// cuántos próximos (24h) y los más urgentes. Las cuatro consultas van en paralelo.
export async function getPendingDashboard(
  now: Date = new Date(),
): Promise<PendingDashboard> {
  const [openCount, overdueCount, upcomingCount, urgent] = await Promise.all([
    countOpenPendings(),
    countOverduePendings(now),
    countUpcomingPendings(now),
    listUrgentPendings(5),
  ]);
  return { openCount, overdueCount, upcomingCount, urgent };
}

/**
 * Registra un pendiente y, si el stock vendible no alcanza, crea un faltante
 * por el déficit enlazado al pendiente (origin). Devuelve qué pasó para que la
 * capa de entrada audite cada efecto.
 *
 * ATÓMICO: el alta del pendiente, la lectura de stock y el alta del faltante
 * corren dentro de una sola transacción interactiva. Si la creación del
 * faltante falla, Prisma hace rollback y NO queda un pendiente sin su faltante.
 */
export async function registerPending(
  data: CreatePendingData,
): Promise<CreatePendingResult> {
  return prisma.$transaction(async (tx) => {
    const pending = await createPending(data, tx);

    // Lectura dentro de la misma transacción para que el déficit sea coherente.
    const sellableStock = await stockByProduct(data.productId, new Date(), tx);
    const missingQuantity = computeMissingQuantity(data.quantity, sellableStock);

    let missingItem: MissingItem | null = null;
    if (missingQuantity > 0) {
      missingItem = await createMissingItem(
        {
          productId: data.productId,
          quantity: missingQuantity,
          originId: pending.id,
          createdById: data.createdById ?? null,
        },
        tx,
      );
    }

    return { pending, missingItem, sellableStock, missingQuantity };
  });
}

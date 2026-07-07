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

import type { Pending, MissingItem, Product } from "@/lib/generated/prisma/client";
import {
  countOpenPendings,
  countOverduePendings,
  countUpcomingPendings,
  createPending,
  listPendings,
  listUrgentPendings,
  type PendingListItem,
} from "@/server/repositories/pending.repository";
import { createProduct } from "@/server/repositories/product.repository";
import { createMissingItem } from "@/server/repositories/missing-item.repository";
import { stockByProduct } from "@/server/repositories/product-batch.repository";
import { prisma } from "@/lib/db/prisma";
import type { Paginated } from "@/lib/pagination";

// Producto manual: no está en el catálogo, se crea al vuelo desde el pendiente.
export type ManualProductInput = { name: string; unit: string };

// Entrada del caso de uso "registrar pendiente". El producto viene de UNA de dos
// formas excluyentes: `productId` (catálogo) o `manual` (se crea al vuelo).
export type RegisterPendingInput = {
  quantity: number;
  promisedAt: Date;
  customerName?: string;
  note?: string;
  createdById?: string | null;
  productId?: string;
  manual?: ManualProductInput;
};

// Prefijo de código para productos creados desde un pendiente manual. Sufijo
// aleatorio para no colisionar con el índice único `code` sin coordinar un
// contador. El ADMIN reemplaza este código por el real al revisar el producto.
function generateManualProductCode(): string {
  return `MAN-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

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
  // El producto creado al vuelo (pendiente manual), o null si vino del catálogo.
  createdProduct: Product | null;
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
 * Si el pendiente refiere a un producto MANUAL (no está en el catálogo), lo crea
 * al vuelo marcado para revisión (`needsReview`) y usa su id. Un producto nuevo
 * no tiene lotes, así que su stock es 0 y el faltante es la cantidad completa.
 *
 * ATÓMICO: alta del producto manual (si aplica), alta del pendiente, lectura de
 * stock y alta del faltante corren en UNA sola transacción interactiva. Si algo
 * falla, Prisma hace rollback y no queda un producto/pendiente huérfano.
 */
export async function registerPending(
  data: RegisterPendingInput,
): Promise<CreatePendingResult> {
  return prisma.$transaction(async (tx) => {
    // Resolver el producto: existente (catálogo) o creado al vuelo (manual).
    let productId = data.productId;
    let createdProduct: Product | null = null;
    if (!productId) {
      if (!data.manual) {
        throw new Error("registerPending: falta el producto (catálogo o manual)");
      }
      createdProduct = await createProduct(
        {
          code: generateManualProductCode(),
          name: data.manual.name,
          unit: data.manual.unit,
          minStock: 0,
          reorderQty: 0,
          needsReview: true,
        },
        tx,
      );
      productId = createdProduct.id;
    }

    const pending = await createPending(
      {
        productId,
        quantity: data.quantity,
        promisedAt: data.promisedAt,
        customerName: data.customerName,
        note: data.note,
        createdById: data.createdById ?? null,
      },
      tx,
    );

    // Lectura dentro de la misma transacción para que el déficit sea coherente.
    const sellableStock = await stockByProduct(productId, new Date(), tx);
    const missingQuantity = computeMissingQuantity(data.quantity, sellableStock);

    let missingItem: MissingItem | null = null;
    if (missingQuantity > 0) {
      missingItem = await createMissingItem(
        {
          productId,
          quantity: missingQuantity,
          originId: pending.id,
          createdById: data.createdById ?? null,
        },
        tx,
      );
    }

    return { pending, missingItem, createdProduct, sellableStock, missingQuantity };
  });
}

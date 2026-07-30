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

import type {
  Pending,
  MissingItem,
  PendingStatus,
  Product,
} from "@/lib/generated/prisma/client";
import {
  cancelPending,
  countOpenPendings,
  countOverduePendings,
  countUpcomingPendings,
  createPending,
  createPendingDelivery,
  lockPendingForUpdate,
  listPendings,
  listUrgentPendings,
  listUsedZones,
  updatePendingAfterDelivery,
  updatePendingManagementStatus,
  type PendingListItem,
  type PendingScope,
} from "@/server/repositories/pending.repository";
import { createProduct } from "@/server/repositories/product.repository";
import { createMissingItem } from "@/server/repositories/missing-item.repository";
import { stockByProduct } from "@/server/repositories/product-batch.repository";
import { prisma } from "@/lib/db/prisma";
import type { Paginated } from "@/lib/pagination";
import {
  nextPendingStatus,
  validateCancellation,
  validateDelivery,
  type DeliveryRejection,
} from "@/features/pendientes/delivery-rules";
import {
  MANAGEMENT_ELIGIBLE_STATUSES,
  type ManagementStatus,
} from "@/features/pendientes/management-status";

// Producto manual: no está en el catálogo, se crea al vuelo desde el pendiente.
export type ManualProductInput = { name: string; unit: string };

// Entrada del caso de uso "registrar pendiente". El producto viene de UNA de dos
// formas excluyentes: `productId` (catálogo) o `manual` (se crea al vuelo).
export type RegisterPendingInput = {
  quantity: number;
  promisedAt: Date;
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  note?: string;
  // Seguimiento del cliente. `zone` llega ya canonizada desde el schema.
  zone?: string;
  totalAmount?: number;
  paidAmount?: number;
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

// Minimización server-side: el nombre del cliente nunca llega al cliente (ni
// siquiera serializado en el HTML) para roles sin `canViewCustomerIdentity`.
//
// `zone` y los montos NO se minimizan, y es una decisión deliberada: la zona es
// un barrio (dato grueso de ruteo, no una dirección) y el saldo es lo que el
// operador tiene que cobrar al entregar. Ocultárselos rompería justo el
// seguimiento que se pidió, sin proteger a nadie: el operador que carga el
// pendiente ya los escribió él mismo.
// Nunca mutamos las filas del repositorio; devolvemos objetos nuevos. Helper
// compartido por `getPendings` y `getPendingDashboard` para que la regla viva
// en un solo lugar.
function minimizeCustomerIdentity(
  items: PendingListItem[],
  canViewCustomerIdentity: boolean,
): PendingListItem[] {
  return canViewCustomerIdentity
    ? items
    : items.map((item) => ({
        ...item,
        customerName: null,
        customerPhone: null,
        customerAddress: null,
      }));
}

export async function getPendings(params: {
  cursor?: string | null;
  take?: number;
  scope?: PendingScope;
  // Requerido (sin default): que falte el flag debe ser un error de tipos,
  // nunca una fuga silenciosa de PII. `false` fuerza la minimización abajo.
  canViewCustomerIdentity: boolean;
}): Promise<Paginated<PendingListItem>> {
  const { canViewCustomerIdentity, ...listParams } = params;
  const { items, nextCursor } = await listPendings(listParams);
  return { items: minimizeCustomerIdentity(items, canViewCustomerIdentity), nextCursor };
}

/**
 * Zonas ya usadas, para sugerirlas en el alta. No es dato del cliente: es el
 * vocabulario de zonas de la droguería, así que no se minimiza por rol.
 */
export async function getUsedZones(): Promise<string[]> {
  return listUsedZones();
}

export type PendingDashboard = {
  openCount: number;
  overdueCount: number;
  upcomingCount: number; // Próximas: promisedAt within 24h, open
  urgent: PendingListItem[];
};

const DASHBOARD_URGENT_PENDING_LIMIT = 5;

// Resumen para el dashboard: cuántos pendientes abiertos hay, cuántos vencidos,
// cuántos próximos (24h) y los más urgentes. Las cuatro consultas van en paralelo.
//
// `urgent` hoy no se renderiza con el nombre del cliente, pero entregarle PII
// a un caller que mañana podría renderizarlo es cómo las fugas pasan por
// costumbre — minimizamos en el boundary, igual que en `getPendings`.
export async function getPendingDashboard(params: {
  canViewCustomerIdentity: boolean;
  now?: Date;
}): Promise<PendingDashboard> {
  const { canViewCustomerIdentity, now = new Date() } = params;
  const [openCount, overdueCount, upcomingCount, urgent] = await Promise.all([
    countOpenPendings(),
    countOverduePendings(now),
    countUpcomingPendings(now),
    listUrgentPendings(DASHBOARD_URGENT_PENDING_LIMIT),
  ]);
  return {
    openCount,
    overdueCount,
    upcomingCount,
    urgent: minimizeCustomerIdentity(urgent, canViewCustomerIdentity),
  };
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
        customerPhone: data.customerPhone,
        customerAddress: data.customerAddress,
        note: data.note,
        zone: data.zone,
        totalAmount: data.totalAmount,
        paidAmount: data.paidAmount,
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

// --------------------------------------------------------------------------
// Ciclo de vida de entrega (Slice A): entregas parciales + cancelación.
//
// IMPORTANTE — LÍMITE DE DOMINIO: entregar un pendiente NUNCA toca
// `MissingItem` (eso es exclusivamente stock de estantería) ni descuenta stock
// (decisión ya tomada, ver cabecera del archivo). Estas funciones solo
// gestionan el compromiso con el cliente.
// --------------------------------------------------------------------------

export type DeliverPendingInput = {
  id: string;
  quantity: number;
  deliveredById: string;
};

export type DeliverPendingResult = {
  pending: {
    id: string;
    status: PendingStatus;
    deliveredQuantity: number;
    completedAt: Date | null;
  } | null;
  rejection: DeliveryRejection | null;
};

// Se lanza cuando el compare-and-set no escribe ninguna fila. Con el lock de
// fila tomado esto es inalcanzable: existe para que una regresión (un llamador
// que se saltee `lockPendingForUpdate`) aborte la transacción en vez de
// corromper el estado en silencio.
class PendingConcurrentModificationError extends Error {
  constructor(id: string) {
    super(`Pending ${id} changed concurrently; transaction rolled back`);
    this.name = "PendingConcurrentModificationError";
  }
}

/**
 * Registra una entrega (parcial o total) sobre un pendiente.
 *
 * CONCURRENCIA: `lockPendingForUpdate` toma un lock de fila (SELECT ... FOR
 * UPDATE) al entrar en la transacción. Dos operadores que entreguen el mismo
 * pendiente en simultáneo se serializan ahí: el segundo espera, relee el
 * `deliveredQuantity` ya confirmado por el primero y su entrega se rechaza con
 * EXCEEDS_REMAINING en vez de sobre-entregar. El compare-and-set del update
 * final es una guarda extra de invariante.
 *
 * Rechazos de negocio (ya entregado, cancelado, cantidad inválida o mayor a lo
 * que resta) NO lanzan: se devuelven para que la Server Action los traduzca a
 * un mensaje. Solo se lanza si el pendiente no existe o si el CAS no escribe.
 */
export async function deliverPending(
  input: DeliverPendingInput,
  now: Date = new Date(),
): Promise<DeliverPendingResult> {
  return prisma.$transaction(async (tx) => {
    const current = await lockPendingForUpdate(tx, input.id);
    if (!current) {
      throw new Error("Pending not found");
    }

    const rejection = validateDelivery({
      status: current.status,
      quantity: current.quantity,
      deliveredQuantity: current.deliveredQuantity,
      deliverQuantity: input.quantity,
    });
    if (rejection) {
      return { pending: null, rejection };
    }

    await createPendingDelivery(tx, {
      pendingId: current.id,
      quantity: input.quantity,
      deliveredById: input.deliveredById,
    });

    const deliveredQuantity = current.deliveredQuantity + input.quantity;
    const status = nextPendingStatus(current.quantity, deliveredQuantity);
    // `completedAt` solo se completa en la transición a ENTREGADO: un
    // pendiente ya ENTREGADO fue rechazado arriba, así que llegar acá con
    // status ENTREGADO significa que la transición ocurre recién ahora.
    const completedAt = status === "ENTREGADO" ? now : null;

    const written = await updatePendingAfterDelivery(tx, {
      id: current.id,
      expectedStatus: current.status,
      expectedDeliveredQuantity: current.deliveredQuantity,
      deliveredQuantity,
      status,
      completedAt,
    });
    // Rollback: la fila de `PendingDelivery` creada arriba se revierte con la
    // transacción, así que el historial de entregas nunca queda inconsistente.
    if (written !== 1) {
      throw new PendingConcurrentModificationError(current.id);
    }

    return {
      pending: { id: current.id, status, deliveredQuantity, completedAt },
      rejection: null,
    };
  });
}

export type CancelPendingInput = {
  id: string;
  cancelledById: string;
  reason?: string;
};

export type CancelPendingResult = {
  pending: {
    id: string;
    status: PendingStatus;
    cancelledAt: Date | null;
  } | null;
  rejection: "ALREADY_DELIVERED" | "ALREADY_CANCELLED" | null;
};

/**
 * Cancela el compromiso de un pendiente. Un pendiente ya ENTREGADO no puede
 * cancelarse retroactivamente (`ALREADY_DELIVERED`); uno ya CANCELADO no se
 * vuelve a cancelar (`ALREADY_CANCELLED`). Ambos casos son rechazos de
 * negocio, no errores: solo se lanza si el pendiente no existe o si el CAS no
 * escribe.
 *
 * CONCURRENCIA: toma el MISMO lock de fila que `deliverPending`, así que ambos
 * flujos se serializan sobre el pendiente. Si una entrega concurrente lo
 * completó, esta transacción espera, relee ENTREGADO y devuelve
 * `ALREADY_DELIVERED` en vez de pisar la entrega.
 */
export async function cancelPendingCommitment(
  input: CancelPendingInput,
  now: Date = new Date(),
): Promise<CancelPendingResult> {
  return prisma.$transaction(async (tx) => {
    const current = await lockPendingForUpdate(tx, input.id);
    if (!current) {
      throw new Error("Pending not found");
    }

    const rejection = validateCancellation(current.status);
    if (rejection) {
      return { pending: null, rejection };
    }

    const written = await cancelPending(tx, {
      id: current.id,
      expectedStatus: current.status,
      cancelledById: input.cancelledById,
      cancelledAt: now,
      cancelReason: input.reason,
    });
    if (written !== 1) {
      throw new PendingConcurrentModificationError(current.id);
    }

    return {
      pending: { id: current.id, status: "CANCELADO", cancelledAt: now },
      rejection: null,
    };
  });
}

// --------------------------------------------------------------------------
// Estado de gestión (Mejora 2): gerencia/compras comunica en qué punto está la
// búsqueda del producto. NO toca stock ni el ciclo de entrega.
// --------------------------------------------------------------------------

export type SetPendingManagementStatusInput = {
  id: string;
  status: ManagementStatus;
  expectedStatus?: PendingStatus;
};

export type SetPendingManagementStatusResult = {
  pending: { id: string; status: PendingStatus } | null;
  // El pendiente no existe o ya no admite gestión (entró a entrega o es
  // terminal). No es un error: la Server Action lo traduce a un mensaje.
  rejection: "NOT_ELIGIBLE" | null;
};

/**
 * Fija un estado de gestión sobre un pendiente abierto. Compare-and-set atómico
 * contra los estados elegibles (`updatePendingManagementStatus`): si el
 * pendiente ya no es elegible (no existe, PARCIAL/ENTREGADO/CANCELADO), devuelve
 * NOT_ELIGIBLE en vez de pisar el estado. AGOTADO NO cancela el pendiente: la
 * cancelación la hace el vendedor por el flujo de siempre.
 */
export async function setPendingManagementStatus(
  input: SetPendingManagementStatusInput,
): Promise<SetPendingManagementStatusResult> {
  const written = await updatePendingManagementStatus({
    id: input.id,
    status: input.status,
    eligibleStatuses: MANAGEMENT_ELIGIBLE_STATUSES,
    expectedStatus: input.expectedStatus,
  });

  if (written !== 1) {
    return { pending: null, rejection: "NOT_ELIGIBLE" };
  }

  return { pending: { id: input.id, status: input.status }, rejection: null };
}

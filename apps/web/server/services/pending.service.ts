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

import {
  type Pending,
  type MissingItem,
  type PendingStatus,
  type Product,
} from "@/lib/generated/prisma/client";
import {
  cancelPending,
  countOpenPendings,
  countOverduePendings,
  countUpcomingPendings,
  createPending,
  createPendingDelivery,
  findPendingByIdempotencyKey,
  lockPendingForUpdate,
  listPendings,
  listUrgentPendings,
  listUsedZones,
  updatePendingAfterDelivery,
  updatePendingManagementStatus,
  type PendingAxisFilters,
  type PendingListItem,
  type PendingScope,
  lockPendingForEdit,
  updatePendingDetails,
  type PendingForEdit,
} from "@/server/repositories/pending.repository";
import { createProduct } from "@/server/repositories/product.repository";
import { createMissingItem } from "@/server/repositories/missing-item.repository";
import {
  claimableStockForPending,
  consumePendingReservations,
  releasePendingReservations,
} from "@/server/repositories/product-batch.repository";
import { prisma } from "@/lib/db/prisma";
import type { Paginated } from "@/lib/pagination";
import {
  nextPendingStatus,
  validateCancellation,
  validateDelivery,
  type DeliveryRejection,
} from "@/features/pendientes/delivery-rules";
import {
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
  // Clave del INTENTO. Obligatoria para toda alta nueva; las filas históricas
  // siguen nullable únicamente por compatibilidad de datos.
  idempotencyKey: string;
};

export class PendingIdempotencyPayloadConflictError extends Error {
  constructor() {
    super("idempotency key was already used for a different pending payload");
  }
}

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
  // true = este intento NO creó nada: su clave de idempotencia ya tenía un
  // pendiente. La acción usa esto para no auditar dos veces el mismo hecho.
  replayed: boolean;
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
  ownerId?: string;
  // Ejes de revisión: acotan QUÉ se lista, nunca QUIÉN puede verlo. El recorte
  // por dueño y la minimización de identidad siguen mandando igual.
  axes?: PendingAxisFilters;
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
  scope?: "global" | "owner";
  ownerId?: string;
  now?: Date;
}): Promise<PendingDashboard> {
  const { canViewCustomerIdentity, scope = "global", ownerId, now = new Date() } = params;
  if (scope === "owner" && !ownerId) throw new Error("owner scope requires ownerId");
  const scopedOwnerId = scope === "owner" ? ownerId : undefined;
  const [openCount, overdueCount, upcomingCount, urgent] = await Promise.all([
    countOpenPendings(scopedOwnerId),
    countOverduePendings(now, scopedOwnerId),
    countUpcomingPendings(now, scopedOwnerId),
    listUrgentPendings(DASHBOARD_URGENT_PENDING_LIMIT, scopedOwnerId),
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
 *
 * IDEMPOTENTE cuando el llamador manda `idempotencyKey`. El operador que
 * reintenta después de un error —o el navegador que reenvía tras un timeout— no
 * puede crear un segundo pendiente con la misma clave. La regla se apoya en el
 * índice único de la columna, no en una comprobación previa: la comprobación
 * sola perdería la carrera entre dos envíos simultáneos, porque ambos leerían
 * "no existe" antes de que ninguno insertara. Por eso hay DOS lecturas, una
 * antes (camino barato) y otra al chocar contra el índice (camino correcto).
 */
export async function registerPending(
  data: RegisterPendingInput,
): Promise<CreatePendingResult> {
  const fingerprint = requestFingerprint(data);
  // Camino barato: el intento ya tiene su pendiente. Ni transacción ni lock.
  const existing = await findPendingByIdempotencyKey(data.idempotencyKey);
  if (existing) return replayRegistration(existing, fingerprint);

  try {
    return await createPendingRegistration(data, fingerprint);
  } catch (error) {
    // Camino correcto: perdimos la carrera contra otro envío con la MISMA clave.
    // El pendiente existe —lo creó el otro— así que esto es un éxito, no un
    // fallo: devolver error acá haría que el operador reintente algo ya hecho.
    if (isIdempotencyConflict(error)) {
      const winner = await findPendingByIdempotencyKey(data.idempotencyKey);
      if (winner) return replayRegistration(winner, fingerprint);
    }
    throw error;
  }
}

/**
 * Detecta P2002 por estructura, no por `instanceof`: Next puede cargar Prisma
 * desde otra copia. Si otro unique produjo el error no habrá ganador por esta
 * clave y el catch lo relanza, evitando convertirlo en replay.
 */
function isIdempotencyConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

function requestFingerprint(data: RegisterPendingInput): string {
  return JSON.stringify({
    productId: data.productId ?? null,
    manual: data.manual
      ? { name: data.manual.name.trim(), unit: data.manual.unit.trim() }
      : null,
    quantity: data.quantity,
    promisedAt: data.promisedAt.toISOString(),
    customerName: data.customerName?.trim() || null,
    customerPhone: data.customerPhone?.trim() || null,
    customerAddress: data.customerAddress?.trim() || null,
    note: data.note?.trim() || null,
    zone: data.zone?.trim() || null,
    totalAmount: data.totalAmount ?? null,
    paidAmount: data.paidAmount ?? 0,
    createdById: data.createdById ?? null,
  });
}

/**
 * Resultado equivalente para un pendiente que YA existía.
 *
 * `createdProduct` va en null a propósito aunque el intento original haya creado
 * un producto manual: ese hecho ya se auditó cuando ocurrió, y devolverlo otra
 * vez haría que la acción lo audite dos veces. Un replay no crea nada, así que
 * no tiene efectos nuevos que reportar.
 */
async function replayRegistration(
  pending: Pending,
  fingerprint: string,
): Promise<CreatePendingResult> {
  if (pending.requestFingerprint !== fingerprint) {
    throw new PendingIdempotencyPayloadConflictError();
  }
  const missingItem = await prisma.missingItem.findFirst({
    where: { originId: pending.id },
    orderBy: { createdAt: "asc" },
  });
  return {
    pending,
    missingItem,
    createdProduct: null,
    sellableStock: pending.inventoryReadyQuantity,
    missingQuantity: computeMissingQuantity(
      pending.quantity,
      pending.inventoryReadyQuantity,
    ),
    replayed: true,
  };
}

function createPendingRegistration(
  data: RegisterPendingInput,
  fingerprint: string,
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
    if (!productId) throw new Error("registerPending: producto no resuelto");

    // El pendiente se crea primero; recién después se calcula qué parte de lo
    // pedido ya está en la droguería. Ese cálculo NO mueve el stock físico.
    const pending = await createPending(
      {
        productId, quantity: data.quantity, promisedAt: data.promisedAt,
        customerName: data.customerName, customerPhone: data.customerPhone,
        customerAddress: data.customerAddress, note: data.note, zone: data.zone,
        totalAmount: data.totalAmount, paidAmount: data.paidAmount,
        createdById: data.createdById ?? null,
        idempotencyKey: data.idempotencyKey,
        requestFingerprint: fingerprint,
      }, tx,
    );
    const inventoryReadyQuantity = await claimableStockForPending(
      tx,
      productId,
      data.quantity,
      new Date(),
    );
    await tx.pending.update({
      where: { id: pending.id },
      data: {
        inventoryReadyQuantity,
        reservedInventoryQuantity: inventoryReadyQuantity,
        availabilityStatus:
          inventoryReadyQuantity === 0
            ? "ESPERANDO"
            : inventoryReadyQuantity === data.quantity
              ? "DISPONIBLE_COMPLETO"
              : "DISPONIBLE_PARCIAL",
      },
    });

    // Lectura dentro de la misma transacción para que el déficit sea coherente.
    const missingQuantity = computeMissingQuantity(data.quantity, inventoryReadyQuantity);

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

    return {
      pending,
      missingItem,
      createdProduct,
      sellableStock: inventoryReadyQuantity,
      missingQuantity,
      replayed: false,
    };
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
  canManageAll?: boolean;
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

    if (!input.canManageAll && current.createdById !== input.deliveredById) {
      return { pending: null, rejection: "NOT_OWNER" };
    }
    const rejection = validateDelivery({
      status: current.status,
      quantity: current.quantity,
      deliveredQuantity: current.deliveredQuantity,
      deliverQuantity: input.quantity,
      invoicedQuantity: current.invoicedQuantity,
      customerStatus: current.customerStatus,
    });
    if (rejection) {
      return { pending: null, rejection };
    }

    await createPendingDelivery(tx, {
      pendingId: current.id,
      quantity: input.quantity,
      deliveredById: input.deliveredById,
    });
    await consumePendingReservations(tx, current.id, input.quantity);

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
    await tx.pending.update({ where: { id: current.id }, data: { customerStatus: status === "ENTREGADO" ? "ENTREGADO" : "FACTURADO" } });
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
  canManageAll?: boolean;
};

export type CancelPendingResult = {
  pending: {
    id: string;
    status: PendingStatus;
    cancelledAt: Date | null;
  } | null;
  rejection: "ALREADY_DELIVERED" | "ALREADY_CANCELLED" | "NOT_OWNER" | null;
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
    if (!input.canManageAll && current.createdById !== input.cancelledById) {
      return { pending: null, rejection: "NOT_OWNER" };
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
    await releasePendingReservations(tx, current.id);
    await tx.missingItem.updateMany({
      where: { originId: current.id, status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] } },
      data: { status: "CANCELADO" },
    });
    await tx.pending.update({ where: { id: current.id }, data: { customerStatus: "CANCELADO" } });

    return {
      pending: { id: current.id, status: "CANCELADO", cancelledAt: now },
      rejection: null,
    };
  });
}

// --------------------------------------------------------------------------
// Cerrar un pendiente con lo que efectivamente se entregó.
//
// Cuando llega solo una parte, el vendedor despacha eso y le pregunta al
// cliente. A veces el cliente espera el resto —y el pendiente sigue abierto,
// que es el comportamiento de siempre—. Otras veces dice que ya no lo quiere,
// o pide juntarlo con otro pedido. Sin esta salida ese pendiente quedaba
// abierto para siempre, ensuciando la cola de todos con algo que ya se resolvió
// en el mostrador.
//
// No es una cancelación: hubo entrega. Desde T2.2b el cierre parcial tiene su
// propio estado terminal CLOSED_PARTIAL: `cancelledQuantity` registra lo que
// el cliente ya no espera (la ecuación `entregado + cancelado = pedido` cierra),
// y `customerStatus` conserva el ENTREGADO para el eje de relación comercial.
// --------------------------------------------------------------------------
export type PartialDecision = "espera" | "va_con_pedido" | "cerrar";

export type ResolvePartialPendingInput = {
  id: string;
  decision: PartialDecision;
  actorId: string;
  canManageAll?: boolean;
};

export type ResolvePartialPendingRejection = "NOT_OWNER" | "NOT_PARTIAL";

// Las dos respuestas que el vendedor trae del mostrador, con las palabras que
// ya usan en su tabla: "cliente espera" y "va con pedido" son NOTAS que el
// vendedor deja, no estados nuevos del sistema. Se registran igual que siempre.
const DECISION_NOTE: Record<Exclude<PartialDecision, "cerrar">, (remaining: number) => string> = {
  espera: (remaining) => `Cliente espera los ${remaining} restantes`,
  va_con_pedido: (remaining) => `Los ${remaining} restantes van con otro pedido`,
};

/**
 * Registra qué pasa con lo que faltó cuando solo llegó una parte.
 *
 * El vendedor despacha lo que hay y le pregunta al cliente. Hay tres
 * respuestas, y las tres existían ya en la operación:
 *
 *   espera         → el cliente aguarda el resto; el pendiente sigue abierto
 *   va_con_pedido  → se le junta con otro pedido; el pendiente sigue abierto
 *   cerrar         → el cliente no lo espera; se cierra con lo entregado
 *
 * Las dos primeras solo dejan la nota: el pendiente sigue vivo y su necesidad
 * de compra también. La tercera cierra, y ahí sí lo que el cliente ya no espera
 * deja de ser algo que comprar.
 */
export async function resolvePartialPending(
  input: ResolvePartialPendingInput,
  now: Date = new Date(),
): Promise<ResolvePartialPendingRejection | null> {
  return prisma.$transaction(async (tx) => {
    const current = await lockPendingForUpdate(tx, input.id);
    if (!current) throw new Error("Pending not found");
    if (!input.canManageAll && current.createdById !== input.actorId) return "NOT_OWNER";

    // Solo desde PARCIAL: sin ninguna entrega no hay resto que decidir, y
    // cerrar de cero es una cancelación, con su propio flujo y su propio motivo.
    if (current.status !== "PARCIAL") return "NOT_PARTIAL";

    const remaining = Math.max(current.quantity - current.deliveredQuantity, 0);

    if (input.decision !== "cerrar") {
      const note = DECISION_NOTE[input.decision](remaining);
      const existing = await tx.pending.findUnique({
        where: { id: current.id },
        select: { note: true },
      });
      await tx.pending.update({
        where: { id: current.id },
        data: {
          note: existing?.note ? `${existing.note} · ${note}` : note,
          // Se guarda la decisión, no solo su nota. Sin esto la fila no sabía
          // que ya se había respondido y volvía a preguntar para siempre.
          partialDecision: input.decision === "espera" ? "ESPERA" : "VA_CON_PEDIDO",
          partialDecisionAt: now,
        },
      });
      return null;
    }

    const { count } = await tx.pending.updateMany({
      where: { id: current.id, status: "PARCIAL" },
      data: {
        // T2.2b: el cierre parcial ya no se disfraza de ENTREGADO. `remaining`
        // ES la cantidad que el cliente no espera; se registra como cancelada
        // para que la ecuación entregado + cancelado = pedido cierre siempre.
        status: "CLOSED_PARTIAL",
        customerStatus: "ENTREGADO",
        cancelledQuantity: remaining,
        completedAt: now,
        cancelReason: `Cerrado sin los ${remaining} restantes: el cliente no los espera`,
      },
    });
    if (count !== 1) throw new PendingConcurrentModificationError(current.id);

    await releasePendingReservations(tx, current.id);
    await tx.missingItem.updateMany({
      where: { originId: current.id, status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] } },
      data: { status: "CANCELADO" },
    });

    return null;
  });
}

export type CustomerLifecycleInput = { id: string; actorId: string; canManageAll?: boolean; quantity?: number };
export type CustomerLifecycleRejection = "NOT_OWNER" | "NOT_AVAILABLE" | "NOT_CONTACTABLE" | "NOT_CONTACTED" | "NOT_INVOICED" | "ALREADY_TERMINAL";

async function lockOwnedPending(tx: Parameters<typeof lockPendingForUpdate>[0], input: CustomerLifecycleInput) {
  const pending = await lockPendingForUpdate(tx, input.id);
  if (!pending) throw new Error("Pending not found");
  if (!input.canManageAll && pending.createdById !== input.actorId) return null;
  return pending;
}

export async function contactPending(input: CustomerLifecycleInput, now = new Date()): Promise<CustomerLifecycleRejection | null> {
  return prisma.$transaction(async (tx) => {
    const pending = await lockOwnedPending(tx, input);
    if (!pending) return "NOT_OWNER";
    if (pending.customerStatus === "ENTREGADO" || pending.customerStatus === "CANCELADO") return "ALREADY_TERMINAL";
    if (pending.customerStatus !== "POR_CONTACTAR") return "NOT_CONTACTABLE";
    if (pending.inventoryReadyQuantity <= 0) return "NOT_AVAILABLE";
    await tx.pending.update({ where: { id: pending.id }, data: { customerStatus: "CONTACTADO", contactedAt: now, contactedById: input.actorId } });
    return null;
  });
}

/**
 * El vendedor marca que ya le facturó al cliente.
 *
 * No se le exige haber registrado un contacto previo ni esperar a que el
 * sistema vea stock disponible: quien factura es la persona, mirando su propia
 * caja, y el software se entera después. Exigirle disponibilidad lo dejaba sin
 * ninguna acción sobre su pendiente hasta que bodega cargara la mercancía.
 *
 * El único techo es lo que el cliente pidió: no se puede facturar de más.
 */
export async function invoicePending(
  input: CustomerLifecycleInput,
  now = new Date(),
): Promise<CustomerLifecycleRejection | null> {
  return prisma.$transaction(async (tx) => {
    const pending = await lockOwnedPending(tx, input);
    if (!pending) return "NOT_OWNER";
    if (pending.customerStatus === "ENTREGADO" || pending.customerStatus === "CANCELADO") {
      return "ALREADY_TERMINAL";
    }

    const quantity = input.quantity ?? pending.quantity - pending.invoicedQuantity;
    const invoicedQuantity = pending.invoicedQuantity + quantity;
    if (!Number.isInteger(quantity) || quantity <= 0 || invoicedQuantity > pending.quantity) {
      return "NOT_AVAILABLE";
    }

    await tx.pending.update({
      where: { id: pending.id },
      data: {
        customerStatus: "FACTURADO",
        invoicedQuantity,
        invoicedAt: now,
        invoicedById: input.actorId,
      },
    });
    return null;
  });
}

// --------------------------------------------------------------------------
// Estado de gestión (Mejora 2): gerencia/compras comunica en qué punto está la
// búsqueda del producto. NO toca stock ni el ciclo de entrega.
// --------------------------------------------------------------------------

export type SetPendingManagementStatusInput = {
  id: string;
  status: ManagementStatus;
  expectedStatus?: ManagementStatus | "POR_PEDIR" | "PENDIENTE";
};

export type SetPendingManagementStatusResult = {
  pending: { id: string; status: ManagementStatus } | null;
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
    purchaseStatus: input.status,
    expectedPurchaseStatus: input.expectedStatus === "PENDIENTE" ? "POR_PEDIR" : input.expectedStatus,
  });

  if (written !== 1) {
    return { pending: null, rejection: "NOT_ELIGIBLE" };
  }

  return { pending: { id: input.id, status: input.status }, rejection: null };
}

// --------------------------------------------------------------------------
// Corregir los datos de un pendiente.
//
// Dos autoridades distintas sobre la misma acción:
//
//   Gerencia  → cualquier pendiente, las veces que haga falta. Es su potestad:
//               corrige lo que el vendedor cargó mal y ajusta lo que se
//               renegoció con el cliente.
//   Vendedor  → solo el suyo y UNA SOLA VEZ. Equivocarse al cargar pasa;
//               corregir en bucle es reescribir la historia de un compromiso.
//
// Lo que no se toca por acá: el ciclo de vida. Un pendiente ya entregado o
// cancelado es historia, y corregir un dato no puede reabrirlo. Y la cantidad
// nunca puede quedar por debajo de lo ya facturado o entregado: eso no sería
// una corrección, sería dejar la fila mintiendo sobre lo que ya pasó.
// --------------------------------------------------------------------------
export type UpdatePendingInput = {
  id: string;
  productId: string;
  quantity: number;
  promisedAt: Date;
  customerName: string;
  customerPhone: string;
  customerAddress?: string;
  note?: string;
  zone?: string;
  totalAmount?: number;
  paidAmount?: number;
  actorId: string;
  canManageAll: boolean;
};

export type UpdatePendingRejection =
  | "NOT_OWNER"
  | "ALREADY_EDITED"
  | "ALREADY_CLOSED"
  | "BELOW_COMMITTED";

export type UpdatePendingResult = {
  rejection: UpdatePendingRejection | null;
  /** Estado previo, para que la auditoría pueda decir qué cambió. */
  before: PendingForEdit | null;
};

export async function updatePending(
  input: UpdatePendingInput,
  now: Date = new Date(),
): Promise<UpdatePendingResult> {
  return prisma.$transaction(async (tx) => {
    const current = await lockPendingForEdit(tx, input.id);
    if (!current) throw new Error("Pending not found");

    if (!input.canManageAll) {
      if (current.createdById !== input.actorId) return { rejection: "NOT_OWNER", before: null };
      // El cupo del vendedor: una corrección y ya.
      if (current.sellerEditedAt !== null) return { rejection: "ALREADY_EDITED", before: null };
    }

    if (
      current.status === "ENTREGADO" ||
      current.status === "CANCELADO" ||
      current.status === "CLOSED_PARTIAL"
    ) {
      return { rejection: "ALREADY_CLOSED", before: null };
    }

    // Bajar la cantidad por debajo de lo ya facturado o entregado dejaría la
    // fila afirmando algo que contradice lo que realmente pasó.
    const committed = Math.max(current.deliveredQuantity, current.invoicedQuantity);
    if (input.quantity < committed) return { rejection: "BELOW_COMMITTED", before: null };

    await updatePendingDetails(tx, {
      id: current.id,
      productId: input.productId,
      quantity: input.quantity,
      promisedAt: input.promisedAt,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      customerAddress: input.customerAddress,
      note: input.note,
      zone: input.zone,
      totalAmount: input.totalAmount,
      paidAmount: input.paidAmount,
      ...(input.canManageAll ? {} : { sellerEditedAt: now }),
    });

    // Cambiar de producto invalida el faltante que este pendiente originó: se
    // generó para conseguir OTRA cosa. Se cancela para que nadie compre lo que
    // ya nadie pidió; el déficit del producto nuevo lo levanta la próxima
    // lectura de disponibilidad.
    if (current.productId !== input.productId) {
      await tx.missingItem.updateMany({
        where: { originId: current.id, status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] } },
        data: { status: "CANCELADO" },
      });
      await releasePendingReservations(tx, current.id);
      await tx.pending.update({
        where: { id: current.id },
        data: {
          inventoryReadyQuantity: 0,
          reservedInventoryQuantity: 0,
          availabilityStatus: "ESPERANDO",
        },
      });
    }

    return { rejection: null, before: current };
  });
}

/**
 * Un pendiente para el formulario de corrección.
 *
 * Devuelve null cuando no existe o cuando quien pregunta no puede corregirlo:
 * la página no tiene que distinguir "no existe" de "no es tuyo" —ambas cosas
 * terminan en la misma pantalla— y no revelar cuál de las dos es evita
 * confirmarle a alguien que un pendiente ajeno existe.
 */
export async function getPendingForEdit(params: {
  id: string;
  actorId: string;
  canManageAll: boolean;
}): Promise<PendingForEdit | null> {
  const pending = await prisma.pending.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      productId: true,
      quantity: true,
      status: true,
      createdById: true,
      deliveredQuantity: true,
      invoicedQuantity: true,
      sellerEditedAt: true,
      customerName: true,
      customerPhone: true,
      customerAddress: true,
      note: true,
      zone: true,
      totalAmount: true,
      paidAmount: true,
      promisedAt: true,
    },
  });
  if (!pending) return null;
  if (!params.canManageAll && pending.createdById !== params.actorId) return null;
  return pending;
}

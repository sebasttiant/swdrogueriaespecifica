// --------------------------------------------------------------------------
// Repositorio de pendientes — ÚNICO lugar que toca Prisma para `Pending`.
// Listado SIEMPRE paginado (cursor-based). Trae el producto asociado para que
// la UI muestre nombre/código sin un query extra.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import {
  clampTake,
  decodeCursor,
  encodeCursor,
  type Paginated,
} from "@/lib/pagination";
import type {
  PendingAvailabilityStatus,
  PendingCustomerStatus,
  PendingIdentityDeferral,
  PendingPurchaseStatus,
  PendingStatus,
  Prisma,
} from "@/lib/generated/prisma/client";

export type PendingListItem = {
  id: string;
  quantity: number;
  status: PendingStatus;
  purchaseStatus?: PendingPurchaseStatus;
  availabilityStatus?: "ESPERANDO" | "LLEGO_BODEGA" | "DISPONIBLE_PARCIAL" | "DISPONIBLE_COMPLETO";
  customerStatus?: "POR_CONTACTAR" | "CONTACTADO" | "FACTURADO" | "ENTREGADO" | "CANCELADO";
  inventoryReadyQuantity?: number;
  invoicedQuantity?: number;
  contactedAt?: Date | null;
  invoicedAt?: Date | null;
  // Qué respondió el cliente sobre lo que faltó, y si el vendedor ya usó su
  // única corrección. La fila los necesita para no volver a ofrecer algo que ya
  // se resolvió.
  partialDecision?: "ESPERA" | "VA_CON_PEDIDO" | null;
  sellerEditedAt?: Date | null;
  promisedAt: Date;
  customerName: string | null;
  // Teléfono canónico (solo dígitos). Null en los pendientes anteriores a que
  // el dato fuera obligatorio: no se inventa un número que nadie dio.
  customerPhone: string | null;
  customerAddress: string | null;
  note: string | null;
  // Seguimiento del cliente. Los montos son enteros de pesos; el estado de pago
  // se deriva de ellos en `features/pendientes/payment-state.ts`, no se lee.
  zone: string | null;
  totalAmount: number | null;
  paidAmount: number;
  createdAt: Date;
  deliveredQuantity: number;
  // T2.2b: lo que el cliente ya no espera de un cierre parcial. Completa la
  // ecuación `delivered + cancelled = quantity` en la UI (T4.2b·B).
  cancelledQuantity: number;
  // T4.3: evidencia de cierre, presente SOLO en la vista de historial (la cola
  // activa no la trae: una fila abierta no se cerró, y el join extra no se paga
  // en la consulta operativa de alta frecuencia). Opcionales a propósito: los
  // registros anteriores a estas columnas no tienen el dato y no se inventa.
  completedAt?: Date | null;
  cancelledAt?: Date | null;
  cancelledBy?: { id: string; name: string } | null;
  cancelReason?: string | null;
  // Auditoría del ENTREGADO: cada entrega dice cantidad, quién y cuándo.
  deliveries?: Array<{
    id: string;
    quantity: number;
    deliveredAt: Date;
    deliveredBy: { id: string; name: string } | null;
  }>;
  product: { id: string; name: string; code: string; unit: string };
  // Quién anotó el pendiente. Gerencia lo necesita para saber a nombre de quién
  // va la venta y quién factura. Se lee de la RELACIÓN, nunca de un texto
  // duplicado en la fila: si el usuario se renombra, esto sigue siendo cierto.
  // Null cuando el usuario ya no resuelve o el pendiente es anterior al dato.
  createdBy: { id: string; name: string } | null;
};

export type CreatePendingData = {
  productId: string;
  quantity: number;
  promisedAt: Date;
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  note?: string;
  // Ya canonizada por el schema (`normalizeZone`): el repositorio no normaliza.
  zone?: string;
  totalAmount?: number;
  paidAmount?: number;
  createdById?: string | null;
  inventoryReadyQuantity?: number;
  reservedInventoryQuantity?: number;
  // Clave del intento que está creando este pendiente. Ver el modelo `Pending`:
  // el índice único sobre esta columna es lo que impide que un reintento cree
  // una segunda fila.
  idempotencyKey: string;
  requestFingerprint: string;
  identitySkippedReason?: PendingIdentityDeferral;
  identitySkippedNote?: string;
};

const LIST_SELECT = {
  id: true,
  quantity: true,
  status: true,
  purchaseStatus: true,
  availabilityStatus: true,
  customerStatus: true,
  inventoryReadyQuantity: true,
  invoicedQuantity: true,
  contactedAt: true,
  invoicedAt: true,
  partialDecision: true,
  sellerEditedAt: true,
  promisedAt: true,
  customerName: true,
  customerPhone: true,
  customerAddress: true,
  note: true,
  zone: true,
  totalAmount: true,
  paidAmount: true,
  createdAt: true,
  deliveredQuantity: true,
  cancelledQuantity: true,
  product: { select: { id: true, name: true, code: true, unit: true } },
  createdBy: { select: { id: true, name: true } },
} as const;

// T4.3: el historial es la AUDITORÍA de cómo se cerró, no solo qué se cerró.
// Este select extiende el listado con la evidencia de cierre: quién canceló y
// cuándo, el motivo, la fecha de cierre y las entregas (cantidad, quién,
// cuándo). Se usa SOLO con scope history; la cola activa no necesita el join y
// no lo paga en la consulta operativa de alta frecuencia.
const HISTORY_SELECT = {
  ...LIST_SELECT,
  completedAt: true,
  cancelledAt: true,
  cancelledBy: { select: { id: true, name: true } },
  cancelReason: true,
  deliveries: {
    select: {
      id: true,
      quantity: true,
      deliveredAt: true,
      deliveredBy: { select: { id: true, name: true } },
    },
    orderBy: { deliveredAt: "asc" as const },
  },
} as const;

// Mismo eje que `MissingItemScope`: "active" es la vista operativa (lo que
// todavía se trabaja) e "history" abre los estados cerrados. El default es
// "active" porque un ENTREGADO/CANCELADO ya no requiere atención y, mezclado en
// la vista por defecto, llena la primera página y empuja los abiertos detrás de
// la paginación.
export type PendingScope = "active" | "history";

// --------------------------------------------------------------------------
// Ejes de revisión (T4.2).
//
// Los tres estados del pendiente son EJES INDEPENDIENTES —compras,
// disponibilidad física y relación comercial— y por eso se filtran por
// separado. Combinarlos estrecha el resultado: pedir "solicitado" Y "llegó a
// bodega" son las dos condiciones a la vez, nunca cualquiera de las dos. Un
// filtro que ensancha al agregarle condiciones no es un filtro.
//
// El eje que no viene NO filtra: ausente significa "cualquiera", no un valor
// por defecto. Así la vista sin filtros sigue siendo exactamente la de antes.
// --------------------------------------------------------------------------
export type PendingAxisFilters = {
  purchase?: PendingPurchaseStatus;
  availability?: PendingAvailabilityStatus;
  customer?: PendingCustomerStatus;
};

function axisWhere(axes: PendingAxisFilters | undefined): Prisma.PendingWhereInput {
  if (!axes) return {};
  return {
    ...(axes.purchase ? { purchaseStatus: axes.purchase } : {}),
    ...(axes.availability ? { availabilityStatus: axes.availability } : {}),
    ...(axes.customer ? { customerStatus: axes.customer } : {}),
  };
}

export async function listPendings(params: {
  cursor?: string | null;
  take?: number;
  scope?: PendingScope;
  ownerId?: string;
  axes?: PendingAxisFilters;
}): Promise<Paginated<PendingListItem>> {
  const take = clampTake(params.take);
  let cursorId = params.cursor ? decodeCursor(params.cursor) : null;

  const where: Prisma.PendingWhereInput = {
    status: { in: params.scope === "history" ? HISTORY_STATUSES : OPEN_STATUSES },
    ...(params.ownerId ? { createdById: params.ownerId } : {}),
    ...axisWhere(params.axes),
  };

  // El cursor es input controlado por el usuario. `decodeCursor` ya descarta la
  // basura (round-trip), pero un cursor bien formado puede apuntar a una fila
  // que ESTA vista no contiene: borrada, de otro dueño, de otro scope o
  // excluida por un filtro de eje. Paginar desde ahí se saltearía resultados
  // válidos, así que en ese caso lo ignoramos y servimos la primera página.
  //
  // Se valida contra el MISMO `where` del listado, no contra una copia de sus
  // condiciones: así agregar un filtro nuevo no deja la validación atrás, que
  // es como esto se convierte en una fuga.
  if (cursorId) {
    const belongsToView = await prisma.pending.findFirst({
      where: { ...where, id: cursorId },
      select: { id: true },
    });
    if (!belongsToView) cursorId = null;
  }

  // take + 1 para detectar página siguiente sin un count extra.
  const rows = await prisma.pending.findMany({
    take: take + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: params.scope === "history" ? HISTORY_SELECT : LIST_SELECT,
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.id) : null;

  return { items, nextCursor };
}

// `client` permite ejecutar dentro de una transacción (Prisma.$transaction);
// por defecto usa el singleton. Así el service compone alta de pendiente +
// faltante de forma atómica sin que el repo conozca la transacción.
// Estados "abiertos": siguen requiriendo atención operativa y aparecen en la
// vista activa y en el conteo de abiertos. Incluye los estados de gestión
// (SOLICITADO/BUSQUEDA/COTIZANDO/AGOTADO): un pendiente en gestión sigue vivo
// hasta que se entrega o se cancela, así que el vendedor debe verlo.
const OPEN_STATUSES: PendingStatus[] = [
  "PENDIENTE",
  "PARCIAL",
  "SOLICITADO",
  "BUSQUEDA",
  "COTIZANDO",
  "AGOTADO",
];
// T2.2b: el cierre parcial también es terminal y va al historial. Es DISTINTO
// de ENTREGADO (no se entregó todo) y de CANCELADO (hubo entrega): su ecuación
// `deliveredQuantity + cancelledQuantity = quantity` conserva la historia.
const HISTORY_STATUSES: PendingStatus[] = ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"];

// Estados que disparan las ALERTAS de vencimiento/urgencia (banner rojo,
// próximas 24h, lista de urgentes). Es OPEN_STATUSES MENOS `AGOTADO`: un
// pendiente marcado agotado ya no tiene acción de gestión pendiente —el
// vendedor lo rechaza por el flujo normal—, así que mantenerlo en la alerta
// roja solo entrena a la gente a ignorarla.
const ALERT_STATUSES: PendingStatus[] = [
  "PENDIENTE",
  "PARCIAL",
  "SOLICITADO",
  "BUSQUEDA",
  "COTIZANDO",
];

export function countOpenPendings(ownerId?: string): Promise<number> {
  return prisma.pending.count({ where: { status: { in: OPEN_STATUSES }, ...(ownerId ? { createdById: ownerId } : {}) } });
}

// Total histórico de pendientes (para reportería: cerrados = total - abiertos).
export function countAllPendings(): Promise<number> {
  return prisma.pending.count();
}

// Reportería: distribución por estado de los pendientes creados desde `since`.
export async function groupPendingsByStatusSince(
  since: Date,
): Promise<{ status: PendingStatus; count: number }[]> {
  const rows = await prisma.pending.groupBy({
    by: ["status"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });
  return rows.map((row) => ({ status: row.status, count: row._count._all }));
}

// Reportería: fechas de creación de pendientes desde `since`, para agrupar la
// tendencia por día en el service (bucketing en hora de Bogotá).
export async function listPendingCreatedAtSince(since: Date): Promise<Date[]> {
  const rows = await prisma.pending.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true },
  });
  return rows.map((row) => row.createdAt);
}

// Vencidos = abiertos-alertables cuya promesa ya pasó. Usa ALERT_STATUSES para
// excluir AGOTADO (ver la nota en la definición de la constante).
export function countOverduePendings(now: Date = new Date(), ownerId?: string): Promise<number> {
  return prisma.pending.count({
    where: { status: { in: ALERT_STATUSES }, promisedAt: { lt: now }, ...(ownerId ? { createdById: ownerId } : {}) },
  });
}

// Próximas = abiertos cuya promesa es >= now y <= now + 24h.
// Spec R4/R5 boundary: exactly now + 24h counts as upcoming (lte, inclusive).
// Disjoint with countOverduePendings by construction (overdue uses lt: now).
const MS_24H = 24 * 60 * 60 * 1000;

export function countUpcomingPendings(now: Date = new Date(), ownerId?: string): Promise<number> {
  return prisma.pending.count({
    where: {
      status: { in: ALERT_STATUSES },
      promisedAt: { gte: now, lte: new Date(now.getTime() + MS_24H) },
      ...(ownerId ? { createdById: ownerId } : {}),
    },
  });
}

// Pendientes más urgentes: los que vencen antes, primero. Alertables (sin
// AGOTADO), como el resto de las señales de urgencia.
export function listUrgentPendings(take: number, ownerId?: string): Promise<PendingListItem[]> {
  return prisma.pending.findMany({
    where: { status: { in: ALERT_STATUSES }, ...(ownerId ? { createdById: ownerId } : {}) },
    take,
    orderBy: [{ promisedAt: "asc" }, { id: "asc" }],
    select: LIST_SELECT,
  });
}

/**
 * Zonas ya usadas, de la usada más recientemente a la más vieja. Alimenta las
 * sugerencias del formulario para que la misma zona se escriba siempre igual.
 *
 * Agrupa con `groupBy` (GROUP BY en SQL), NO con `findMany` + `distinct`: ahí
 * el `take` recorta filas antes de deduplicar, así que treinta pendientes de
 * la misma zona devolverían una sola sugerencia. Agrupando, el `take` acota
 * zonas distintas, que es lo que la pantalla necesita.
 *
 * `take` acotado como en todo listado del repositorio: son sugerencias de un
 * campo de texto, no un catálogo que haya que recorrer entero.
 */
export async function listUsedZones(take = 30): Promise<string[]> {
  const groups = await prisma.pending.groupBy({
    by: ["zone"],
    where: { zone: { not: null } },
    // Última vez que se usó la zona: ordena las sugerencias por vigencia real.
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: "desc" } },
    take,
  });

  // El `where` ya descarta los null; el filtro deja el tipo en string[] sin un
  // non-null assertion que mentiría si la condición cambiara.
  return groups
    .map((group) => group.zone)
    .filter((zone): zone is string => zone !== null);
}

/**
 * Busca el pendiente que un intento ya creó, por su clave de idempotencia.
 *
 * Es la mitad de lectura de la regla anti-duplicado: antes de crear se consulta
 * acá, y si el `create` choca contra el índice único se vuelve a consultar acá
 * para devolver la fila que ganó la carrera.
 */
export function findPendingByIdempotencyKey(
  idempotencyKey: string,
  client: Prisma.TransactionClient = prisma,
) {
  return client.pending.findUnique({ where: { idempotencyKey } });
}

export async function createPending(
  data: CreatePendingData,
  client: Prisma.TransactionClient = prisma,
) {
  return client.pending.create({
    data: {
      productId: data.productId,
      quantity: data.quantity,
      promisedAt: data.promisedAt,
      customerName: data.customerName ?? null,
      customerPhone: data.customerPhone ?? null,
      customerAddress: data.customerAddress ?? null,
      note: data.note ?? null,
      zone: data.zone ?? null,
      totalAmount: data.totalAmount ?? null,
      // Cero, no null: "no abonó" es un hecho conocido, no un dato ausente.
      paidAmount: data.paidAmount ?? 0,
      createdById: data.createdById ?? null,
      idempotencyKey: data.idempotencyKey,
      requestFingerprint: data.requestFingerprint,
      identitySkippedReason: data.identitySkippedReason ?? null,
      identitySkippedNote: data.identitySkippedNote ?? null,
      inventoryReadyQuantity: data.inventoryReadyQuantity ?? 0,
      reservedInventoryQuantity: data.reservedInventoryQuantity ?? 0,
      availabilityStatus: (data.inventoryReadyQuantity ?? 0) === 0
        ? "ESPERANDO"
        : (data.inventoryReadyQuantity ?? 0) === data.quantity
          ? "DISPONIBLE_COMPLETO"
          : "DISPONIBLE_PARCIAL",
    },
  });
}

// --------------------------------------------------------------------------
// Ciclo de vida de entrega (Slice A): entregas parciales + cancelación.
// --------------------------------------------------------------------------

export type PendingForDelivery = {
  id: string;
  quantity: number;
  deliveredQuantity: number;
  status: PendingStatus;
  createdById: string | null;
  inventoryReadyQuantity: number;
  invoicedQuantity: number;
  customerStatus: "POR_CONTACTAR" | "CONTACTADO" | "FACTURADO" | "ENTREGADO" | "CANCELADO";
};

/**
 * Bloquea (FOR UPDATE) la fila del pendiente y devuelve los campos que las
 * reglas de entrega/cancelación necesitan. DEBE llamarse dentro de una
 * transacción interactiva.
 *
 * El lock de fila —no la transacción por sí sola— es lo que serializa dos
 * requests concurrentes sobre el mismo pendiente: bajo READ COMMITTED (el
 * default de Postgres) una lectura plana no bloquea nada y ambos operadores
 * verían el mismo `deliveredQuantity`. Con FOR UPDATE la segunda transacción
 * espera acá hasta que la primera confirme, y recién entonces lee el estado ya
 * escrito. Así la sobre-entrega y la cancelación contra un estado obsoleto las
 * rechazan las reglas de negocio normales, en vez de pisarse en silencio.
 *
 * Devuelve `null` si el pendiente no existe.
 */
export async function lockPendingForUpdate(
  client: Prisma.TransactionClient,
  id: string,
): Promise<PendingForDelivery | null> {
  const rows = await client.$queryRaw<PendingForDelivery[]>`
    SELECT id, quantity, "deliveredQuantity", status, "createdById", "inventoryReadyQuantity", "invoicedQuantity", "customerStatus"
    FROM pendings WHERE id = ${id} FOR UPDATE
  `;
  return rows[0] ?? null;
}

export type CreatePendingDeliveryData = {
  pendingId: string;
  quantity: number;
  deliveredById: string;
};

export function createPendingDelivery(
  tx: Prisma.TransactionClient,
  data: CreatePendingDeliveryData,
) {
  return tx.pendingDelivery.create({
    data: {
      pendingId: data.pendingId,
      quantity: data.quantity,
      deliveredById: data.deliveredById,
    },
  });
}

export type UpdatePendingAfterDeliveryData = {
  id: string;
  // Estado leído bajo el lock. La escritura solo aplica si la fila sigue igual.
  expectedStatus: PendingStatus;
  expectedDeliveredQuantity: number;
  deliveredQuantity: number;
  status: PendingStatus;
  completedAt: Date | null;
};

/**
 * Compare-and-set: escribe solo si `status` y `deliveredQuantity` siguen siendo
 * los que se leyeron bajo el lock. Devuelve la cantidad de filas escritas (0 o
 * 1). Con `lockPendingForUpdate` tomado el CAS nunca falla; queda como guarda
 * de invariante para que un llamador futuro que se saltee el lock falle ruidoso
 * en vez de sobre-entregar en silencio.
 */
export async function updatePendingAfterDelivery(
  tx: Prisma.TransactionClient,
  data: UpdatePendingAfterDeliveryData,
): Promise<number> {
  const { count } = await tx.pending.updateMany({
    where: {
      id: data.id,
      status: data.expectedStatus,
      deliveredQuantity: data.expectedDeliveredQuantity,
    },
    data: {
      deliveredQuantity: data.deliveredQuantity,
      status: data.status,
      completedAt: data.completedAt,
    },
  });
  return count;
}

export type CancelPendingData = {
  id: string;
  // Estado leído bajo el lock: solo cancelamos si la fila no cambió desde ahí.
  expectedStatus: PendingStatus;
  cancelledById: string;
  cancelledAt: Date;
  cancelReason?: string;
};

/**
 * Compare-and-set de la cancelación: escribe solo si el pendiente sigue en el
 * estado leído bajo `lockPendingForUpdate`. Devuelve las filas escritas (0 o 1).
 * Impide que una cancelación pise una entrega concurrente que ya confirmó.
 */
export async function cancelPending(
  tx: Prisma.TransactionClient,
  data: CancelPendingData,
): Promise<number> {
  const { count } = await tx.pending.updateMany({
    where: { id: data.id, status: data.expectedStatus },
    data: {
      status: "CANCELADO",
      cancelledAt: data.cancelledAt,
      cancelledById: data.cancelledById,
      cancelReason: data.cancelReason ?? null,
    },
  });
  return count;
}

// --------------------------------------------------------------------------
// Estado de gestión (Mejora 2): gerencia/compras fija SOLICITADO/BUSQUEDA/
// COTIZANDO/AGOTADO sobre un pendiente abierto.
// --------------------------------------------------------------------------

export type UpdatePendingManagementStatusData = {
  id: string;
  purchaseStatus?: PendingPurchaseStatus;
  // Estados desde los que el cambio es válido. El guard va en el WHERE para que
  // el update sea un compare-and-set atómico: si una entrega/cancelación
  // concurrente ya movió la fila fuera de este set, no se escribe.
  expectedPurchaseStatus?: PendingPurchaseStatus;
  /** @deprecated legacy caller compatibility; never written. */
  status?: PendingStatus;
  /** @deprecated legacy caller compatibility; authority is purchaseStatus. */
  eligibleStatuses?: PendingStatus[];
  expectedStatus?: PendingStatus;
  // El atajo de "Ya lo pedí" compara contra lo que vio al renderizar; evita
  // sobrescribir una decisión concurrente distinta de gerencia.
};

function legacyPurchaseStatus(status: PendingStatus | undefined): PendingPurchaseStatus | undefined {
  if (status === "PENDIENTE") return "POR_PEDIR";
  if (status === "SOLICITADO" || status === "BUSQUEDA" || status === "COTIZANDO" || status === "AGOTADO") return status;
  return undefined;
}

/**
 * Compare-and-set del estado de gestión: escribe solo si el pendiente sigue en
 * un estado elegible. Devuelve las filas escritas (0 o 1). `0` significa que el
 * pendiente no existe o ya no admite gestión (entregado/parcial/cancelado/cierre
 * parcial): así un cambio de gestión nunca pisa una entrega o cancelación
 * concurrente.
 */
export async function updatePendingManagementStatus(
  data: UpdatePendingManagementStatusData,
): Promise<number> {
  const { count } = await prisma.pending.updateMany({
    where: {
      id: data.id,
      status: { notIn: ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"] },
      purchaseStatus: data.expectedPurchaseStatus ?? legacyPurchaseStatus(data.expectedStatus),
    },
    data: { purchaseStatus: data.purchaseStatus ?? legacyPurchaseStatus(data.status) ?? "POR_PEDIR" },
  });
  return count;
}

// --------------------------------------------------------------------------
// Edición de los datos de un pendiente.
//
// Escribe SOLO los campos del pedido —producto, cantidad, promesa y cliente—.
// El ciclo de vida (status, entregado, facturado, cancelado) no se toca por acá:
// eso lo mueven las acciones propias de cada transición, con sus reglas y su
// auditoría. Corregir un dato mal cargado no puede tener el poder de saltear
// una entrega.
// --------------------------------------------------------------------------
export type UpdatePendingDetailsData = {
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
  /** Marca el cupo de corrección del vendedor. Gerencia no lo consume. */
  sellerEditedAt?: Date;
};

export async function updatePendingDetails(
  tx: Prisma.TransactionClient,
  data: UpdatePendingDetailsData,
): Promise<void> {
  const { id, sellerEditedAt, ...fields } = data;
  await tx.pending.update({
    where: { id },
    data: {
      ...fields,
      customerAddress: fields.customerAddress ?? null,
      note: fields.note ?? null,
      zone: fields.zone ?? null,
      totalAmount: fields.totalAmount ?? null,
      paidAmount: fields.paidAmount ?? 0,
      ...(sellerEditedAt ? { sellerEditedAt } : {}),
    },
  });
}

/** Datos del pendiente que la edición necesita leer bajo el lock. */
export type PendingForEdit = {
  id: string;
  productId: string;
  quantity: number;
  status: PendingStatus;
  createdById: string | null;
  deliveredQuantity: number;
  invoicedQuantity: number;
  sellerEditedAt: Date | null;
  customerName: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  note: string | null;
  zone: string | null;
  totalAmount: number | null;
  paidAmount: number;
  promisedAt: Date;
};

export async function lockPendingForEdit(
  client: Prisma.TransactionClient,
  id: string,
): Promise<PendingForEdit | null> {
  const rows = await client.$queryRaw<PendingForEdit[]>`
    SELECT id, "productId", quantity, status, "createdById", "deliveredQuantity",
           "invoicedQuantity", "sellerEditedAt", "customerName", "customerPhone",
           "customerAddress", note, zone, "totalAmount", "paidAmount", "promisedAt"
    FROM pendings WHERE id = ${id} FOR UPDATE
  `;
  return rows[0] ?? null;
}

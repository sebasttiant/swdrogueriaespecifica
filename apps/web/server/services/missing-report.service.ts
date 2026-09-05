import { normalizeMissingReportName } from "@/features/faltantes/missing-report-name";
import type { ReportQueueScope } from "@/features/faltantes/report-queue-scope";
import { prisma } from "@/lib/db/prisma";
import { Prisma, type MissingReportStatus } from "@/lib/generated/prisma/client";
import { clampTake } from "@/lib/pagination";
import {
  createMissingItem,
  fillMissingItemLaboratory,
  findActionableMissingItemByProduct,
  markMissingItemArrived,
} from "@/server/repositories/missing-item.repository";
import {
  countPendingReportGroups,
  createMissingReport,
  groupPendingReportsByName,
  linkMissingReports,
  resolveMissingReports,
  markReportsOrdered,
  findPendingGroupDisplayName,
  getOrderedGroupMissingItemId,
  markReportsArrived,
  listMissingReportsForReporter,
  type MissingReportResolution,
  listPendingReportsForNames,
  type PendingReportRow,
} from "@/server/repositories/missing-report.repository";
import { findProductById, upsertProvisionalProduct } from "@/server/repositories/product.repository";

export type SubmitMissingReportInput = {
  // Nombre tal cual lo pegó el vendedor desde Orión. Se conserva para mostrar.
  rawName: string;
  // Código operativo opcional informado por el vendedor.
  sellerCode?: string;
  // Siempre desde la sesión en la capa de acción; el service no lo deriva.
  reporterId: string;
  // Presentación del producto, si el vendedor la sabe. Se usa SOLO al crear el
  // producto provisional: ver `upsertProvisionalProduct`.
  presentation?: string;
  // Laboratorio, si el vendedor lo sabe. Llega ya resuelto a un ID por la capa
  // de acción; el service no crea laboratorios.
  requestedLaboratoryId?: string;
};

// El nombre pasó la validación de Zod (presencia + longitud) pero al normalizar
// quedó vacío: p. ej. solo caracteres de control, que `trim` no elimina. Es un
// error de validación de dominio, no un fallo de infraestructura; la acción lo
// mapea a un mensaje para el vendedor y NO persiste nada.
export class MissingReportEmptyNameError extends Error {
  constructor() {
    super("Missing report name is empty after normalization");
    this.name = "MissingReportEmptyNameError";
  }
}

// Cantidad con la que nace un faltante reportado. El formulario no la pide —el
// vendedor informa QUÉ falta, no cuánto comprar— y gerencia fija la compra real
// en `orderedQuantity` al pedir. No puede ser 0: el cierre FIFO trata
// `quantity <= disponible` como "cubierto", así que un 0 cerraría el faltante
// con cualquier entrada de inventario. Es el mismo 1 que usan el alta manual
// (`MANUAL_MISSING_ITEM_QUANTITY`) y la vinculación al catálogo.
const REPORTED_MISSING_ITEM_QUANTITY = 1;

const REPORTED_MISSING_ITEM_NOTE = "Reportado por vendedor";

/**
 * El vendedor reporta que algo falta, y eso aparece DIRECTO en "Por pedir".
 *
 * ANTES: esto solo escribía un `MissingReport` en `PENDING_REVIEW`. El faltante
 * canónico nacía después, cuando gerencia entraba a una cola aparte y aprobaba
 * el reporte. En la pantalla eso se veía como dos pestañas llamadas igual —
 * "Por pedir 0" arriba y otro "Por pedir" adentro de "Reportes 20"—, así que
 * gerencia leía el cero y concluía que no había nada que comprar mientras veinte
 * solicitudes esperaban detrás. La aprobación tampoco agregaba una decisión: el
 * vendedor ya había decidido que el producto falta. Era un paso que solo
 * escondía trabajo (reunión 2026-10-04).
 *
 * AHORA: el reporte y su faltante nacen juntos, en UNA transacción.
 *
 * PRODUCTO. `MissingItem.productId` es NOT NULL con FK, así que un faltante
 * necesita un producto sí o sí. `upsertProvisionalProduct` crea uno marcado
 * `needsReview` sobre el índice único `provisionalNormalizedName`, o devuelve el
 * que ya existe. No se inventa catálogo curado: queda marcado para que un ADMIN
 * lo revise, igual que el alta manual de un pendiente.
 *
 * DUPLICADOS. Dos vendedores que reportan lo mismo no generan dos filas en la
 * cola: el segundo se engancha al faltante que abrió el primero. Los dos
 * reportes se conservan enteros —quién y cuándo— apuntando al mismo faltante.
 *
 * CONCURRENCIA. Serializable, igual que `linkReportToProduct`. Dos envíos
 * simultáneos con el mismo nombre normalizado no pueden crear dos faltantes
 * equivalentes: el índice único del producto los fuerza a compartir producto, y
 * el aislamiento hace que el segundo vea el faltante del primero o reintente.
 *
 * ATÓMICO. Nunca queda un reporte sin su faltante ni un faltante sin el rastro
 * de quién lo pidió: si algo falla, no se persiste nada.
 */
export async function submitMissingReport(input: SubmitMissingReportInput) {
  const normalizedName = normalizeMissingReportName(input.rawName);
  if (normalizedName === "") throw new MissingReportEmptyNameError();

  return prisma.$transaction(
    async (tx) => {
      const product = await upsertProvisionalProduct(tx, {
        normalizedName,
        displayName: input.rawName,
        presentation: input.presentation,
      });

      const existing = await findActionableMissingItemByProduct(product.id, tx);
      const missingItem =
        existing ??
        (await createMissingItem(
          {
            productId: product.id,
            quantity: REPORTED_MISSING_ITEM_QUANTITY,
            // No nace de un pendiente de cliente: es reposición de estantería.
            originId: null,
            createdById: input.reporterId,
            note: REPORTED_MISSING_ITEM_NOTE,
            sellerCode: input.sellerCode,
            requestedLaboratoryId: input.requestedLaboratoryId,
          },
          tx,
        ));

      // El segundo reporte COMPLETA, nunca pisa.
      //
      // Dos vendedores reportan el mismo producto y comparten faltante. Si el
      // primero no sabía el laboratorio y el segundo sí, ese dato es información
      // nueva y vale guardarla. Pero si el primero ya lo informó, el segundo NO
      // lo cambia: quien decide una compra vio un laboratorio, y que se le mueva
      // por debajo es peor que no tenerlo. Corregirlo es una edición explícita,
      // no un efecto colateral de reportar.
      if (existing && !existing.requestedLaboratoryId && input.requestedLaboratoryId) {
        await fillMissingItemLaboratory(existing.id, input.requestedLaboratoryId, tx);
      }

      // El reporte queda LINKED desde el vamos, apuntando al faltante que lo
      // representa. Es la trazabilidad que después permite responder "¿quién
      // pidió esto?" sobre una fila de la cola.
      return createMissingReport(
        {
          rawName: input.rawName,
          normalizedName,
          sellerCode: input.sellerCode,
          reporterId: input.reporterId,
          status: "LINKED",
          linkedProductId: product.id,
          linkedMissingItemId: missingItem.id,
        },
        tx,
      );
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/**
 * Cuántos grupos históricos quedan en el buzón. Decide si la pestaña "Reportes"
 * se dibuja: en cero desaparece y la pantalla queda con un solo "Por pedir".
 */
export function getPendingReportGroupCount(): Promise<number> {
  return countPendingReportGroups();
}

// --------------------------------------------------------------------------
// Cola de revisión de gerencia (solo lectura).
//
// Agrupa los reportes pendientes por `normalizedName` para no repetir el mismo
// producto reportado por varios vendedores. El conteo cuenta REPORTES, nunca
// suma cantidades: un MissingReport no tiene cantidad. Cada reporte individual
// se conserva en el historial del grupo, con quién lo reportó y cuándo.
//
// `normalizedName` es interno (sirve para agrupar); lo que se muestra es
// `displayName`: el nombre original del reporte más reciente, tal como lo pegó
// el vendedor desde Orión.
// --------------------------------------------------------------------------

export type MissingReportQueueGroup = {
  normalizedName: string;
  displayName: string;
  count: number;
  latestReportedAt: Date | null;
  reports: PendingReportRow[];
};

export type MissingReportQueue = {
  groups: MissingReportQueueGroup[];
  hasMore: boolean;
  page: number;
};

// Cada vista corresponde a un tramo inequívoco del circuito físico.
export const REPORT_QUEUE_STATUSES: Record<
  ReportQueueScope,
  MissingReportStatus | MissingReportStatus[]
> = {
  pending: "PENDING_REVIEW",
  ordered: "ORDERED",
  arrived: "EN_BODEGA",
  discarded: "DISCARDED",
};

export async function getMissingReportQueue(params: {
  page: number;
  pageSize: number;
  scope: ReportQueueScope;
}): Promise<MissingReportQueue> {
  const page = Math.max(1, Math.trunc(params.page));
  // `pageSize` llega del llamador (en la UI, de la URL): se acota con la misma
  // convención de paginación del proyecto. Sin esto, un `take <= 0` haría que
  // Prisma lea en orden inverso, y un valor enorme abriría una consulta sin cota.
  const pageSize = clampTake(params.pageSize);

  // Se pide un grupo de más para saber si hay página siguiente sin un count
  // extra. Paginación por offset: `groupBy` no admite cursor.
  const status = REPORT_QUEUE_STATUSES[params.scope];
  const rows = await groupPendingReportsByName({
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
    status,
  });

  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

  // Una sola consulta para el historial de TODOS los grupos de la página: nunca
  // una consulta por grupo.
  const reports = await listPendingReportsForNames(
    pageRows.map((row) => row.normalizedName),
    status,
  );

  const byName = new Map<string, PendingReportRow[]>();
  for (const report of reports) {
    const bucket = byName.get(report.normalizedName);
    if (bucket) bucket.push(report);
    else byName.set(report.normalizedName, [report]);
  }

  const groups = pageRows.flatMap((row) => {
    // `listPendingReportsForNames` ya viene ordenado por fecha desc, así que el
    // primero del grupo es el reporte más reciente.
    const groupReports = byName.get(row.normalizedName) ?? [];
    const newest = groupReports[0];

    // Un grupo sin reportes visibles solo puede venir de una carrera entre las
    // dos lecturas (no hay transacción: es una cola de solo lectura). Se omite:
    // mostrarlo dejaría el nombre NORMALIZADO interno en pantalla como si fuera
    // el nombre del producto, y un conteo que ya no corresponde.
    if (!newest) return [];

    return [
      {
        normalizedName: row.normalizedName,
        displayName: newest.rawName,
        count: row.count,
        latestReportedAt: row.latestReportedAt,
        reports: groupReports,
      },
    ];
  });

  return { groups, hasMore, page };
}

// --------------------------------------------------------------------------
// Vinculación: gerencia revisa un grupo de reportes y lo convierte en un
// faltante canónico apuntando a un producto del catálogo.
//
// Se crea UN solo MissingItem para todo el grupo —varios vendedores reportando
// el mismo producto son un único faltante—, y todos los reportes del grupo
// quedan LINKED apuntando a él. Las filas se conservan: son el rastro de quién
// reportó y cuándo.
// --------------------------------------------------------------------------

// Cantidad con la que nace el faltante generado desde un reporte. Es un
// PLACEHOLDER: el vendedor no sabe cuánto comprar, y gerencia define la cantidad
// real al pedir (`orderedQuantity`, desde C2Q). No puede ser 0: el cierre FIFO
// trata `quantity <= disponible` como "cubierto", así que un 0 cerraría el
// faltante con cualquier entrada de inventario.
const LINKED_REPORT_PLACEHOLDER_QUANTITY = 1;

const LINKED_REPORT_NOTE = "Generado desde reporte de vendedor";

// Rechazo de negocio de la vinculación: producto inexistente o inactivo, o un
// grupo que otro gerente ya vinculó. La acción lo traduce a un mensaje.
export class MissingReportLinkError extends Error {
  constructor(
    readonly reason: "PRODUCT_NOT_FOUND" | "ALREADY_LINKED",
    message: string,
  ) {
    super(message);
    this.name = "MissingReportLinkError";
  }
}

export type LinkReportToProductInput = {
  normalizedName: string;
  productId: string;
  // Gerente que vincula. Viene de la sesión en la capa de acción.
  userId: string;
};

export async function linkReportToProduct(input: LinkReportToProductInput) {
  // El producto se valida ANTES de crear nada: un producto inexistente o
  // inactivo no debe dejar un faltante huérfano.
  const product = await findProductById(input.productId);
  if (!product || !product.active) {
    throw new MissingReportLinkError(
      "PRODUCT_NOT_FOUND",
      "Product not found or inactive",
    );
  }

  // Crear el faltante y marcar los reportes es TODO o NADA. Si el CAS no
  // coincide (otro gerente ganó la carrera), el throw revierte la transacción y
  // el faltante recién creado no queda persistido: sin esto quedaría huérfano,
  // sin ningún reporte apuntándole y visible en la cola de faltantes.
  return prisma.$transaction(async (tx) => {
    const missingItem = await createMissingItem(
      {
        productId: input.productId,
        quantity: LINKED_REPORT_PLACEHOLDER_QUANTITY,
        originId: null,
        createdById: input.userId,
        note: LINKED_REPORT_NOTE,
      },
      tx,
    );

    const linkedReportIds = await linkMissingReports(
      {
        normalizedName: input.normalizedName,
        productId: input.productId,
        missingItemId: missingItem.id,
      },
      tx,
    );

    if (linkedReportIds.length === 0) {
      throw new MissingReportLinkError(
        "ALREADY_LINKED",
        "Reports were already reviewed by someone else",
      );
    }

    return { missingItem, linkedReportsCount: linkedReportIds.length };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

// --------------------------------------------------------------------------
// Resolución RÁPIDA de un grupo de reportes.
//
// Regla del gerente (reunión 2026-07-30): lee el nombre que pegó el vendedor, ya
// sabe qué producto es, y lo pide por teléfono. Hasta ahora la única salida de
// la cola era vincular al catálogo, así que un producto no cargado dejaba el
// reporte atrapado y la cola solo crecía.
//
// Se resuelve el GRUPO entero —todos los reportes del mismo nombre—, que es la
// unidad que la cola muestra: marcar "uno de los cuatro reportes de tiamina"
// no significa nada operativamente.
//
// No crea faltante ni toca el catálogo. El precio, explícito: un reporte
// resuelto así no se cierra solo cuando entra la mercadería, porque nadie dijo
// qué producto es. Quien quiera ese seguimiento tiene `linkReportToProduct`.
// --------------------------------------------------------------------------

export type ResolveReportsInput = {
  normalizedName: string;
  resolution: MissingReportResolution;
  // Estado que la pantalla observó. El compare-and-set lo exige: "ya llegó"
  // espera ORDERED, así nadie marca como recibido algo que nunca se pidió.
  expectedStatus?: MissingReportStatus;
  // Gerente que resuelve. Viene de la sesión en la capa de acción, nunca del
  // formulario.
  userId: string;
};

export type ResolveReportsResult = {
  // Reportes efectivamente escritos por esta llamada.
  resolved: number;
  reportIds: string[];
};

// El grupo que muestra la cola es indivisible. Si cualquier reporte dejó de
// estar pendiente entre el render y el click, la transacción completa revierte
// para no mezclar decisiones de gerentes distintos dentro del mismo grupo.
export class MissingReportResolveConflictError extends Error {
  constructor() {
    super("Missing report group was already partially reviewed");
    this.name = "MissingReportResolveConflictError";
  }
}

const REPORT_PLACEHOLDER_QUANTITY = 1;
const REPORT_ORDER_NOTE = "Generado desde reporte de vendedor";

export async function orderReports(
  input: { normalizedName: string; userId: string },
  now: Date = new Date(),
): Promise<ResolveReportsResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const displayName = await findPendingGroupDisplayName(tx, input.normalizedName);
      if (!displayName) throw new MissingReportResolveConflictError();
      const product = await upsertProvisionalProduct(tx, {
        normalizedName: input.normalizedName,
        displayName,
      });
      const missingItem = await createMissingItem({
        productId: product.id,
        quantity: REPORT_PLACEHOLDER_QUANTITY,
        originId: null,
        createdById: input.userId,
        note: REPORT_ORDER_NOTE,
        status: "PEDIDO",
        orderedQuantity: REPORT_PLACEHOLDER_QUANTITY,
        orderedAt: now,
        orderedById: input.userId,
      }, tx);
      const reportIds = await markReportsOrdered(tx, {
        normalizedName: input.normalizedName,
        productId: product.id,
        missingItemId: missingItem.id,
        resolvedById: input.userId,
        resolvedAt: now,
      });
      if (reportIds.length === 0) throw new MissingReportResolveConflictError();
      return { resolved: reportIds.length, reportIds };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isSerializableConflict(error)) throw new MissingReportResolveConflictError();
    throw error;
  }
}

export async function markReportsArrivedAtWarehouse(
  input: { normalizedName: string; userId: string },
  now: Date = new Date(),
): Promise<ResolveReportsResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const missingItemId = await getOrderedGroupMissingItemId(tx, input.normalizedName);
      if (!missingItemId) throw new MissingReportResolveConflictError();
      const reports = await markReportsArrived(tx, {
        normalizedName: input.normalizedName,
        arrivedById: input.userId,
        arrivedAt: now,
      });
      if (reports.length === 0) throw new MissingReportResolveConflictError();
      const changed = await markMissingItemArrived(tx, {
        id: missingItemId,
        arrivedById: input.userId,
        arrivedAt: now,
      });
      if (changed !== 1) throw new MissingReportResolveConflictError();
      return { resolved: reports.length, reportIds: reports };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isSerializableConflict(error)) throw new MissingReportResolveConflictError();
    throw error;
  }
}

export async function getMyMissingReports(reporterId: string) {
  return listMissingReportsForReporter(reporterId);
}

function isSerializableConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2034"
  );
}

export async function resolveReports(
  input: ResolveReportsInput,
  now: Date = new Date(),
): Promise<ResolveReportsResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const reportIds = await resolveMissingReports(
        {
          normalizedName: input.normalizedName,
          resolution: input.resolution,
          expectedStatus: input.expectedStatus,
          resolvedById: input.userId,
          resolvedAt: now,
        },
        tx,
      );

      if (reportIds.length === 0) {
        throw new MissingReportResolveConflictError();
      }

      return { resolved: reportIds.length, reportIds };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isSerializableConflict(error)) throw new MissingReportResolveConflictError();
    throw error;
  }
}

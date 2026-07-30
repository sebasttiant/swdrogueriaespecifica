import { normalizeMissingReportName } from "@/features/faltantes/missing-report-name";
import { prisma } from "@/lib/db/prisma";
import { Prisma } from "@/lib/generated/prisma/client";
import { clampTake } from "@/lib/pagination";
import { createMissingItem } from "@/server/repositories/missing-item.repository";
import {
  createMissingReport,
  groupPendingReportsByName,
  linkMissingReports,
  resolveMissingReports,
  type MissingReportResolution,
  listPendingReportsForNames,
  type PendingReportRow,
} from "@/server/repositories/missing-report.repository";
import { findProductById } from "@/server/repositories/product.repository";

export type SubmitMissingReportInput = {
  // Nombre tal cual lo pegó el vendedor desde Orión. Se conserva para mostrar.
  rawName: string;
  // Código operativo opcional informado por el vendedor.
  sellerCode?: string;
  // Siempre desde la sesión en la capa de acción; el service no lo deriva.
  reporterId: string;
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

// Registra un reporte provisional: normaliza el nombre para poder agrupar
// reportes del mismo producto más adelante, conservando el nombre original.
// No crea Product ni MissingItem, no maneja cantidades ni proveedores: es solo
// la observación "esto falta", pendiente de revisión de gerencia.
export async function submitMissingReport(input: SubmitMissingReportInput) {
  const normalizedName = normalizeMissingReportName(input.rawName);
  if (normalizedName === "") throw new MissingReportEmptyNameError();

  return createMissingReport({
    rawName: input.rawName,
    normalizedName,
    sellerCode: input.sellerCode,
    reporterId: input.reporterId,
  });
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

export async function getMissingReportQueue(params: {
  page: number;
  pageSize: number;
}): Promise<MissingReportQueue> {
  const page = Math.max(1, Math.trunc(params.page));
  // `pageSize` llega del llamador (en la UI, de la URL): se acota con la misma
  // convención de paginación del proyecto. Sin esto, un `take <= 0` haría que
  // Prisma lea en orden inverso, y un valor enorme abriría una consulta sin cota.
  const pageSize = clampTake(params.pageSize);

  // Se pide un grupo de más para saber si hay página siguiente sin un count
  // extra. Paginación por offset: `groupBy` no admite cursor.
  const rows = await groupPendingReportsByName({
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
  });

  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

  // Una sola consulta para el historial de TODOS los grupos de la página: nunca
  // una consulta por grupo.
  const reports = await listPendingReportsForNames(
    pageRows.map((row) => row.normalizedName),
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

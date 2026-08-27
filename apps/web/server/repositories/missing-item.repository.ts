// --------------------------------------------------------------------------
// Repositorio de faltantes — ÚNICO lugar que toca Prisma para `MissingItem`.
// Listado SIEMPRE paginado (cursor-based). `originId` enlaza al pendiente que
// lo generó automáticamente; null = faltante manual (no implementado todavía).
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import {
  clampTake,
  decodeCursor,
  encodeCursor,
  type Paginated,
} from "@/lib/pagination";
import type {
  MissingItemStatus,
  PendingStatus,
  Prisma,
} from "@/lib/generated/prisma/client";

export type CloseMissingItemsByEntryParams = {
  productId: string;
  availableQuantity: number;
};

export type MissingItemListItem = {
  id: string;
  quantity: number;
  // Cantidad ESPERADA. Desde D10 la deriva el chulito de `quantity`; sigue en
  // null en faltantes sin pedir y en registros anteriores al backfill.
  orderedQuantity: number | null;
  // Cantidad REAL que entró, cargada por bodega al recibir. Es otro número que
  // el esperado y nunca lo pisa.
  receivedQuantity: number;
  note: string | null;
  status: MissingItemStatus;
  originId: string | null;
  confirmedAt: Date | null;
  confirmedById: string | null;
  confirmationNote: string | null;
  orderedAt: Date | null;
  orderedById: string | null;
  discardedAt: Date | null;
  discardedById: string | null;
  supplierId: string | null;
  sellerCode: string | null;
  createdAt: Date;
  product: {
    id: string;
    name: string;
    code: string;
    unit: string;
    laboratory: { id: string; name: string } | null;
  };
  origin: {
    id: string;
    promisedAt: Date;
    status: PendingStatus;
    customerName: string | null;
  } | null;
  supplier: { id: string; name: string } | null;
  // Quién autorizó, leído de la relación real. `confirmedById` puede apuntar a
  // un usuario ya no resoluble, así que la relación es la única fuente del
  // nombre: nunca se duplica como texto en la fila del faltante.
  confirmedBy: { id: string; name: string } | null;
  // Quién CREÓ el faltante (Mejora 5, trazabilidad). Para uno auto-generado
  // desde un pendiente es el vendedor; para un alta manual o un reporte
  // vinculado es gerencia. El "solicitante" real lo resuelve el service
  // (reporte → reporter; si no, este createdBy). Mismo criterio de visibilidad
  // que `confirmedBy`: nombre de staff, no PII de cliente.
  createdBy: { id: string; name: string } | null;
  // Quién PIDIÓ y quién DESCARTÓ. La cola la trabajan dos personas a la vez
  // (gerencia y compras) y hasta ahora no se distinguía quién tocó qué: el
  // gerente tuvo que preguntarlo en voz alta durante la reunión del 2026-07-30
  // ("¿quién colocó esto? ... ah, eso lo colocó Andrés"). Igual que los otros
  // responsables: la relación es la única fuente del nombre, y solo id+nombre.
  orderedBy: { id: string; name: string } | null;
  discardedBy: { id: string; name: string } | null;
};

export type CreateMissingItemData = {
  productId: string;
  quantity: number;
  originId?: string | null;
  createdById?: string | null;
  note?: string | null;
  sellerCode?: string | null;
  orderedQuantity?: number | null;
  status?: MissingItemStatus;
  orderedAt?: Date;
  orderedById?: string;
  // T3: laboratorio solicitado por el cliente.
  requestedLaboratoryId?: string | null;
};

// Vistas de la cola operativa. Cada una responde una pregunta distinta del
// gerente, con sus palabras: "por pedir" / "ya pedidos" / "descartados".
//
// `actionable` es el default: la cola de trabajo real. NO es sinónimo de
// "abierto" —ver `ACTIONABLE_STATUSES` vs `OPEN_STATUSES` más abajo—.
export type MissingItemScope =
  | "actionable"
  | "ordered"
  | "quarantine"
  | "discarded"
  | "history";

export type ConfirmMissingItemData = {
  id: string;
  confirmedById: string;
  confirmedAt?: Date;
  note?: string;
};

// Proveedor y cantidad son OPCIONALES a propósito: el pedido rápido registra el
// hecho ("gerencia ya compró esto") sin frenar al gerente para elegir proveedor
// y cantidad, que puede completar después con el formulario largo. La base ya
// los acepta nulos —`supplierId String?`, `orderedQuantity Int?` con CHECK
// "IS NULL OR > 0"—, así que esto NO necesita migración.
export type OrderMissingItemData = {
  supplierId?: string | null;
  orderedById: string;
  orderedAt: Date;
  orderedQuantity?: number | null;
};

const LIST_SELECT = {
  id: true,
  quantity: true,
  orderedQuantity: true,
  // La vista dice "faltaban N · llegaron M": lo recibido es la mitad de esa
  // frase, así que el listado tiene que traerlo.
  receivedQuantity: true,
  note: true,
  status: true,
  originId: true,
  confirmedAt: true,
  confirmedById: true,
  confirmationNote: true,
  orderedAt: true,
  orderedById: true,
  discardedAt: true,
  discardedById: true,
  supplierId: true,
  sellerCode: true,
  createdAt: true,
  product: {
    select: {
      id: true,
      name: true,
      code: true,
      unit: true,
      laboratory: { select: { id: true, name: true } },
    },
  },
  origin: {
    select: { id: true, promisedAt: true, status: true, customerName: true },
  },
  supplier: { select: { id: true, name: true } },
  // Decisión explícita: el nombre de quien autorizó es visible para TODO rol
  // que pueda ver /faltantes, incluido OPERADOR. Es trazabilidad operativa
  // interna, no PII de cliente: a diferencia de `origin.customerName` —que el
  // service borra sin `canViewCustomerIdentity`— acá no hay gate por capability.
  // Se seleccionan solo id y nombre; nunca email, rol ni credenciales.
  confirmedBy: { select: { id: true, name: true } },
  // Trazabilidad (Mejora 5): quién creó el faltante. Solo id y nombre.
  createdBy: { select: { id: true, name: true } },
  // Quién pidió y quién descartó, para que la vista lo muestre. Mismo criterio
  // de minimización que los anteriores: nunca email, rol ni credenciales.
  orderedBy: { select: { id: true, name: true } },
  discardedBy: { select: { id: true, name: true } },
} as const;

export async function listMissingItems(params: {
  cursor?: string | null;
  take?: number;
  scope?: MissingItemScope;
}): Promise<Paginated<MissingItemListItem>> {
  const take = clampTake(params.take);
  let cursorId = params.cursor ? decodeCursor(params.cursor) : null;

  // El cursor es input controlado por el usuario. `decodeCursor` ya descarta la
  // basura (round-trip), pero un cursor bien formado puede apuntar a un id que
  // no existe (registro borrado o cursor inventado). Validamos su existencia con
  // un lookup barato por PK: si no existe, lo ignoramos y servimos la primera
  // página. Así un cursor inutilizable nunca rompe la consulta de paginación.
  if (cursorId) {
    const exists = await prisma.missingItem.findUnique({
      where: { id: cursorId },
      select: { id: true },
    });
    if (!exists) cursorId = null;
  }

  const where = whereForScope(params.scope);

  const rows = await prisma.missingItem.findMany({
    take: take + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    ...(where ? { where } : {}),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: LIST_SELECT,
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.id) : null;

  return { items, nextCursor };
}

// --------------------------------------------------------------------------
// DOS EJES DISTINTOS. No los unifiques: comparten valores hoy por casualidad,
// no por significado, y mezclarlos ya causó un bug silencioso una vez.
//
//   OPEN_STATUSES      = "todavía no se resolvió". Un PEDIDO entra acá porque
//                        la mercadería no llegó: sigue contando como abierto,
//                        sigue venciendo, y —lo más importante— sigue siendo
//                        candidato del cierre FIFO cuando entra el stock.
//
//   ACTIONABLE_STATUSES = "todavía requiere que gerencia HAGA algo". Un PEDIDO
//                        NO entra: ya se compró, no hay nada que decidir.
//
// Regla del gerente (reunión 2026-07-30): "cuando ellos le pongan el okay, que
// desaparezca de la lista". Eso es el eje ACTIONABLE, y solo afecta a la cola.
// Si alguna vez sacás PEDIDO de OPEN_STATUSES, los faltantes ya pedidos dejan
// de cerrarse solos al llegar la mercadería y se acumulan para siempre.
// --------------------------------------------------------------------------
const OPEN_STATUSES: MissingItemStatus[] = ["FALTANTE", "PEDIDO"];
const RECONCILABLE_STATUSES: MissingItemStatus[] = [
  ...OPEN_STATUSES,
  "EN_BODEGA",
];
const ACTIONABLE_STATUSES: MissingItemStatus[] = ["FALTANTE"];
const ORDERED_STATUSES: MissingItemStatus[] = ["PEDIDO", "RECIBIDO"];

// --------------------------------------------------------------------------
// CUARENTENA (D10): datos genuinamente inválidos, que no pertenecen a ninguna
// cola operativa. Queda UN caso, no dos.
//
// La otra invalidez imaginable —cantidad esperada ≤ 0— NO se filtra acá porque
// la base ya la hace imposible: `missing_items_ordered_quantity_positive`
// (CHECK "orderedQuantity" IS NULL OR > 0), agregado SIN `NOT VALID`, así que
// PostgreSQL validó también las filas que ya existían. Filtrar por algo que un
// constraint impide es un filtro que nunca coincide, y peor: le hace creer al
// que lo lee que el caso ocurre. En su lugar el CHECK se fija con un test de
// catálogo (`ya-pedidos.pg.test.ts`), que es lo que avisa si una migración
// futura lo afloja.
//
// `orderedQuantity` NULA tampoco es inválida: es "todavía sin derivar", el
// estado de las filas anteriores a D10. Esconderlas sería castigar a la
// operación por un dato que nunca se le pidió; siguen en la cola hasta que el
// backfill las complete.
// --------------------------------------------------------------------------
//
// Son FUNCIONES y no constantes a propósito: `prisma.<model>.fields` se resuelve
// contra el cliente, y evaluarlo al importar el módulo obligaría a cada test
// unitario que mockea Prisma a declarar `fields` en su doble solo para que el
// archivo cargue. Difiriéndolo, el import no toca el cliente y los dobles
// siguen siendo tan chicos como el test necesita.
function quarantineWhere() {
  // Comparación COLUMNA contra COLUMNA: la hace PostgreSQL, no el código sobre
  // filas ya traídas. En memoria, la paginación por cursor devolvería páginas
  // de tamaños distintos según cuántas descartara después de consultarlas.
  return { receivedQuantity: { gt: prisma.missingItem.fields.orderedQuantity } };
}

// Le falta mercadería por llegar. Null = sin derivar todavía, sigue faltando.
function incompleteWhere() {
  return {
    OR: [
      { orderedQuantity: null },
      { receivedQuantity: { lt: prisma.missingItem.fields.orderedQuantity } },
    ],
  };
}

/**
 * Filtro de cada vista. `undefined` = sin filtro (historial completo).
 *
 * `ordered` es la cola ACTIVA de "Ya pedidos", y activa significa UNA cosa: se
 * pidió y todavía no llegó todo. Un RECIBIDO ya no está esperando nada, así
 * que sale de acá y vive en el historial. Cola activa e historial son
 * conjuntos disjuntos a propósito: mezclarlos hacía que la pantalla creciera
 * para siempre y que "¿qué estoy esperando?" no tuviera respuesta.
 *
 * Incluye los PEDIDOS HISTÓRICOS: filas que quedaron en `FALTANTE` con
 * `confirmedAt` del flujo viejo "OK gerencia". Son órdenes reales que nunca se
 * recibieron; sin esta rama no aparecerían en ninguna vista operativa. Nunca
 * se reescriben ni se migran: se leen donde corresponde.
 */
function whereForScope(scope: MissingItemScope | undefined) {
  switch (scope) {
    case "history":
      return undefined;
    case "ordered":
      return {
        AND: [
          {
            OR: [
              { status: "PEDIDO" as const },
              { status: "FALTANTE" as const, confirmedAt: { not: null } },
            ],
          },
          incompleteWhere(),
          { NOT: quarantineWhere() },
        ],
      };
    case "quarantine":
      return quarantineWhere();
    case "discarded":
      return { status: "CANCELADO" as const };
    default:
      return {
        AND: [
          { confirmedAt: null, status: { in: ACTIONABLE_STATUSES } },
          { NOT: quarantineWhere() },
        ],
      };
  }
}

export function countOpenMissingItems(): Promise<number> {
  return prisma.missingItem.count({
    where: { confirmedAt: null, status: { in: OPEN_STATUSES } },
  });
}

/**
 * Cuántos faltantes siguen esperando que gerencia los pida. Es el número que le
 * importa al gerente ("cuánto me falta"), y NO es `countOpenMissingItems`: ese
 * incluye los ya pedidos, que siguen abiertos pero no requieren trabajo.
 */
export function countActionableMissingItems(): Promise<number> {
  return prisma.missingItem.count({
    where: { confirmedAt: null, status: { in: ACTIONABLE_STATUSES } },
  });
}

// Export (Mejora 3): TODOS los faltantes abiertos, sin paginar, para volcarlos a
// CSV/Excel. Acotado a un máximo defensivo: la cola operativa son cientos, no
// millones, pero el tope evita que un export barra la tabla entera si algo se
// desmadra. Mismo orden que la lista (más nuevos primero).
const EXPORT_MAX = 2000;

export function listOpenMissingItemsForExport(): Promise<MissingItemListItem[]> {
  return prisma.missingItem.findMany({
    where: { confirmedAt: null, status: { in: OPEN_STATUSES } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: EXPORT_MAX,
    select: LIST_SELECT,
  });
}

// Total histórico de faltantes (para reportería: cerrados = total - abiertos).
export function countAllMissingItems(): Promise<number> {
  return prisma.missingItem.count();
}

// Faltantes ya pedidos a un proveedor (chip "Pedidos" de la cola operativa).
export function countOrderedMissingItems(): Promise<number> {
  return prisma.missingItem.count({ where: { status: "PEDIDO" } });
}

// Faltantes con "OK gerencia". Se cuenta por `confirmedAt` —el hecho registrado—
// y no por estado: el service garantiza que un PEDIDO nunca queda confirmado.
export function countConfirmedMissingItems(): Promise<number> {
  return prisma.missingItem.count({ where: { confirmedAt: { not: null } } });
}

// Faltantes creados desde `since` (para el conteo "del día").
export function countMissingItemsCreatedSince(since: Date): Promise<number> {
  return prisma.missingItem.count({ where: { createdAt: { gte: since } } });
}

// Reportería: distribución por estado de los faltantes creados desde `since`.
export async function groupMissingItemsByStatusSince(
  since: Date,
): Promise<{ status: MissingItemStatus; count: number }[]> {
  const rows = await prisma.missingItem.groupBy({
    by: ["status"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });
  return rows.map((row) => ({ status: row.status, count: row._count._all }));
}

// Reportería: fechas de creación de faltantes desde `since`, para agrupar la
// tendencia por día en el service (bucketing en hora de Bogotá).
export async function listMissingItemCreatedAtSince(since: Date): Promise<Date[]> {
  const rows = await prisma.missingItem.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true },
  });
  return rows.map((row) => row.createdAt);
}

// Faltantes ACCIONABLES (sin confirmar, solo FALTANTE) creados antes de
// `threshold`: los que llevan demasiado tiempo sin que gerencia los gestione.
// Base de la alerta de gerencia "no se han cerrado".
//
// Usa ACTIONABLE_STATUSES y NO OPEN_STATUSES a propósito: la alerta debe mostrar
// solo lo que requiere trabajo de gestión. Los ya pedidos (PEDIDO) siguen su
// curso hacia la llegada de la mercadería y no deben inflar este número —regla
// de la reunión 2026-08-14: "cuando le dan 'ya lo pedí', sale de la alerta".
export function countUnclosedActionableMissingItemsBefore(
  threshold: Date,
): Promise<number> {
  return prisma.missingItem.count({
    where: {
      confirmedAt: null,
      status: { in: ACTIONABLE_STATUSES },
      createdAt: { lt: threshold },
    },
  });
}

export function countOverdueMissingItems(now: Date = new Date()): Promise<number> {
  return prisma.missingItem.count({
    where: {
      status: { in: OPEN_STATUSES },
      confirmedAt: null,
      originId: { not: null },
      origin: { promisedAt: { lt: now } },
    },
  });
}

// `client` permite ejecutar dentro de una transacción (ver pending.service).
export async function createMissingItem(
  data: CreateMissingItemData,
  client: Prisma.TransactionClient = prisma,
) {
  return client.missingItem.create({
    data: {
      productId: data.productId,
      quantity: data.quantity,
      note: data.note ?? null,
      originId: data.originId ?? null,
      createdById: data.createdById ?? null,
      sellerCode: data.sellerCode ?? null,
      status: data.status,
      orderedAt: data.orderedAt,
      orderedById: data.orderedById,
      orderedQuantity: data.orderedQuantity,
      // T3: laboratorio solicitado por el cliente.
      requestedLaboratoryId: data.requestedLaboratoryId ?? null,
    },
  });
}

export async function markMissingItemArrived(
  tx: Prisma.TransactionClient,
  data: { id: string; arrivedById: string; arrivedAt: Date },
): Promise<number> {
  const { count } = await tx.missingItem.updateMany({
    where: { id: data.id, status: "PEDIDO", confirmedAt: null },
    data: { status: "EN_BODEGA", arrivedById: data.arrivedById, arrivedAt: data.arrivedAt },
  });
  if (count === 0) return 0;

  // La llegada física también es noticia para el cliente que lo está
  // esperando. En la reunión eso es el VERDE: "ya llegó a la droguería, pero
  // no lo han cargado al sistema". Sin este salto el pendiente del vendedor no
  // se enteraba de nada hasta que bodega terminara de cargar el lote.
  //
  // Solo avanza desde ESPERANDO: si el pendiente ya está disponible (amarillo)
  // retroceder a verde sería mentirle al vendedor.
  const arrived = await tx.missingItem.findUnique({
    where: { id: data.id },
    select: { originId: true },
  });
  if (arrived?.originId) {
    await tx.pending.updateMany({
      where: {
        id: arrived.originId,
        availabilityStatus: "ESPERANDO",
        // T2.2b: un cierre parcial es terminal; no resucitar a LLEGO_BODEGA.
        status: { notIn: ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"] },
      },
      data: { availabilityStatus: "LLEGO_BODEGA" },
    });
  }
  return count;
}

export type ArrivedMissingItem = {
  id: string;
  productId: string;
  product: { name: string; code: string };
  arrivedAt: Date | null;
  requestedByName: string | null;
  // Lo que todavía falta recibir de este faltante. Bodega no tiene por qué
  // recordarlo ni buscarlo: viaja hasta el formulario y llega escrito.
  pendingQuantity: number;
};

export async function listArrivedMissingItems(): Promise<ArrivedMissingItem[]> {
  const items = await prisma.missingItem.findMany({
    // Lo que está FÍSICAMENTE en bodega esperando que lo terminen de cargar, y
    // son dos poblaciones distintas:
    //
    //   * `EN_BODEGA`: bodega avisó que llegó y todavía no hay entrada.
    //   * Parcialmente recibido: ya entró parte y falta el resto.
    //
    // La segunda hay que nombrarla aparte desde D10. Antes caía acá de rebote
    // porque una recepción parcial escribía `EN_BODEGA`, y al dejar de hacerlo
    // —ese valor significa otra cosa— estos ítems desaparecían de la pantalla
    // de entradas: bodega perdía de vista lo que llegó a medias, que es justo
    // lo que `pendingQuantity` existe para responder.
    where: {
      confirmedAt: null,
      OR: [
        { status: "EN_BODEGA" as const },
        {
          status: { in: ["FALTANTE", "PEDIDO"] as MissingItemStatus[] },
          receivedQuantity: { gt: 0 },
        },
      ],
    },
    orderBy: [{ arrivedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      productId: true,
      arrivedAt: true,
      quantity: true,
      receivedQuantity: true,
      orderedQuantity: true,
      product: { select: { name: true, code: true } },
    },
  });
  const reports = await prisma.missingReport.findMany({
    where: { linkedMissingItemId: { in: items.map((item) => item.id) } },
    select: { linkedMissingItemId: true, reporter: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const names = new Map<string, string>();
  for (const report of reports) {
    if (report.linkedMissingItemId && !names.has(report.linkedMissingItemId)) {
      names.set(report.linkedMissingItemId, report.reporter.name);
    }
  }
  return items.map(({ quantity, receivedQuantity, orderedQuantity, ...item }) => ({
    ...item,
    requestedByName: names.get(item.id) ?? null,
    // Lo pedido manda sobre la necesidad original: si gerencia pidió 20 de un
    // déficit de 12, lo que va a entrar por la puerta son 20. Menos lo que ya
    // se recibió en entregas anteriores del proveedor.
    pendingQuantity: Math.max((orderedQuantity ?? quantity) - receivedQuantity, 1),
  }));
}

// --------------------------------------------------------------------------
// closeMissingItemsByEntry
//
// Cierra faltantes abiertos para un producto usando FIFO (createdAt ASC) dentro
// de una transacción existente. El estado cerrado es RECIBIDO (el faltante fue
// suplido por la entrada). La cantidad disponible se resta item a item; si el
// siguiente item no cabe en el restante, se DETIENE (sin cierre parcial).
//
// Retorna el array de ids de los faltantes cerrados para que el llamador pueda
// registrar auditoría y mostrar el conteo en la UI.
// --------------------------------------------------------------------------
export async function closeMissingItemsByEntry(
  tx: Prisma.TransactionClient,
  params: CloseMissingItemsByEntryParams,
): Promise<string[]> {
  const openItems = await tx.missingItem.findMany({
    where: {
      productId: params.productId,
      status: { in: RECONCILABLE_STATUSES },
      confirmedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      quantity: true,
      originId: true,
      orderedQuantity: true,
    },
  });

  let remaining = params.availableQuantity;
  const closedIds: string[] = [];

  for (const item of openItems) {
    // El `quantity = 1` de un faltante manual es un sentinel técnico, no una
    // necesidad. Solo participa después de pedirlo, usando `orderedQuantity`.
    // Los automáticos conservan su déficit calculado en `quantity`.
    const effectiveQuantity =
      item.originId === null ? item.orderedQuantity : item.quantity;
    if (effectiveQuantity === null) continue;
    if (effectiveQuantity > remaining) break;

    const { count } = await tx.missingItem.updateMany({
      where: {
        id: item.id,
        status: item.status,
        confirmedAt: null,
      },
      data: { status: "RECIBIDO" },
    });

    // Otra entrada pudo cerrar esta fila entre el listado y el CAS. En ese
    // caso esta recepción conserva su cantidad disponible para el siguiente
    // faltante elegible y no cuenta un cierre que no hizo.
    if (count !== 1) continue;

    remaining -= effectiveQuantity;
    closedIds.push(item.id);
  }

  return closedIds;
}

export type MissingItemForUpdate = {
  id: string;
  status: MissingItemStatus;
  confirmedAt: Date | null;
  confirmedById: string | null;
  confirmationNote: string | null;
  orderedAt: Date | null;
  orderedById: string | null;
  supplierId: string | null;
  productId: string;
  /** Necesidad registrada. Es de donde el chulito DERIVA la cantidad esperada (D10). */
  quantity: number;
  orderedQuantity: number | null;
};

/**
 * Bloquea (FOR UPDATE) la fila del faltante. DEBE llamarse dentro de una
 * transacción interactiva.
 *
 * Es lo que serializa las transiciones de estado del faltante: sin el lock, dos
 * gerentes pidiendo el mismo faltante a proveedores distintos leen ambos
 * `FALTANTE` y la última escritura gana, dejando la auditoría contradiciendo la
 * realidad. `orderMissingItem` y `confirmMissingItemOk` toman ESTE MISMO lock,
 * así que tampoco pueden cruzarse para producir el estado imposible
 * PEDIDO + confirmedAt.
 *
 * `productId` se incluye porque el pedido enlaza el producto con el proveedor.
 * Devuelve `null` si el faltante no existe.
 */
export async function lockMissingItemForUpdate(
  client: Prisma.TransactionClient,
  id: string,
): Promise<MissingItemForUpdate | null> {
  const rows = await client.$queryRaw<MissingItemForUpdate[]>`
    SELECT id, status, "confirmedAt", "confirmedById", "confirmationNote",
           "orderedAt", "orderedById", "supplierId", "productId",
           quantity, "orderedQuantity"
    FROM missing_items WHERE id = ${id} FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Compare-and-set del pedido: escribe solo si el faltante sigue FALTANTE y sin
 * confirmar, tal como se leyó bajo el lock. Devuelve las filas escritas (0 o 1).
 * `tx` es obligatorio: esta escritura corre SIEMPRE dentro de la transacción del
 * pedido (lock + upserts + este update en un solo átomo), nunca suelta.
 */
export async function orderMissingItem(
  tx: Prisma.TransactionClient,
  id: string,
  data: OrderMissingItemData,
): Promise<number> {
  const { count } = await tx.missingItem.updateMany({
    where: { id, status: "FALTANTE", confirmedAt: null },
    data: {
      status: "PEDIDO",
      orderedAt: data.orderedAt,
      orderedById: data.orderedById,
      supplierId: data.supplierId ?? null,
      // La cantidad pedida entra en el MISMO update atómico que el status: si
      // el CAS no coincide (pedido concurrente), tampoco se escribe la cantidad.
      orderedQuantity: data.orderedQuantity ?? null,
    },
  });
  return count;
}

/**
 * Compare-and-set de la confirmación ("OK gerencia"): escribe solo si el
 * faltante sigue FALTANTE y sin confirmar. Refuerza la invariante del service:
 * un faltante que un pedido concurrente pasó a PEDIDO no coincide, así que la
 * confirmación no puede colarse y producir el estado imposible
 * PEDIDO + confirmedAt — incluso si un llamador futuro se saltea el lock de
 * fila. Devuelve las filas escritas (0 o 1). `tx` es obligatorio: corre bajo
 * el mismo lock que `orderMissingItem`.
 */
export async function confirmMissingItem(
  tx: Prisma.TransactionClient,
  data: ConfirmMissingItemData,
): Promise<number> {
  const { count } = await tx.missingItem.updateMany({
    where: { id: data.id, status: "FALTANTE", confirmedAt: null },
    data: {
      confirmedAt: data.confirmedAt ?? new Date(),
      confirmedById: data.confirmedById,
      confirmationNote: data.note ?? null,
    },
  });
  return count;
}

/**
 * Compare-and-set del descarte: escribe solo si el faltante sigue FALTANTE y
 * sin confirmar, tal como se leyó bajo el lock. Devuelve las filas escritas
 * (0 o 1), así el service distingue "descartado" de "otro lo tocó primero".
 *
 * `tx` es obligatorio, igual que en `orderMissingItem`: el descarte corre
 * siempre dentro de la transacción que tomó el lock, nunca suelto.
 *
 * Escribe en columnas PROPIAS (`discardedAt`/`discardedById`/`discardReason`) y
 * NO reutiliza `confirmedAt`/`confirmedById`. Sobrecargar un campo cuyo nombre
 * significa otra cosa es el error que ya costó el rollback de "OK gerencia":
 * meses después nadie puede decir si esa fecha fue una confirmación o un
 * descarte, y las consultas que filtran por `confirmedAt` empiezan a mentir.
 */
export async function discardMissingItem(
  tx: Prisma.TransactionClient,
  id: string,
  data: { discardedById: string; discardedAt: Date; reason?: string },
): Promise<number> {
  const { count } = await tx.missingItem.updateMany({
    where: { id, status: "FALTANTE", confirmedAt: null },
    data: {
      status: "CANCELADO",
      discardedAt: data.discardedAt,
      discardedById: data.discardedById,
      discardReason: data.reason ?? null,
    },
  });
  return count;
}

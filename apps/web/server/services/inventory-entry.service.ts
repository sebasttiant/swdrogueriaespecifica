// --------------------------------------------------------------------------
// Servicio de entradas de inventario (server-only). Boundary de negocio del
// caso de uso "registrar una entrada de stock".
//
// Slice 1: registerInventoryEntry — UNA transacción con DOS escrituras:
//   1. upsertBatchQuantity: crea o incrementa el lote físico en ProductBatch.
//   2. createInventoryEntry: escribe la fila de ledger en InventoryEntry.
//
// Slice 2: closeMissingItemsByEntry — dentro de la MISMA transacción, cierra
// faltantes abiertos para el producto usando FIFO. Atómico: stock, ledger y
// reconciliación de faltantes se confirman o revierten juntos.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { Paginated } from "@/lib/pagination";
import {
  closeMissingItemsByEntry,
  listArrivedMissingItems,
} from "@/server/repositories/missing-item.repository";
import { markReportsReceivedByMissingItemIds } from "@/server/repositories/missing-report.repository";
import {
  findOrCreateLaboratory,
  LaboratoryResolutionInvariantError,
} from "@/server/repositories/laboratory.repository";
import type { Prisma } from "@/lib/generated/prisma/client";
import { laboratoryCreateCommandKey } from "@/server/domain/laboratory/identity";
import {
  lockProductForEntry,
  type EntryProductSnapshot,
} from "@/server/repositories/product.repository";
import {
  lockBatchForEntry,
  reserveReceivedBatchQuantity,
  reserveBatchForPending,
  upsertBatchQuantity,
} from "@/server/repositories/product-batch.repository";
import { deriveReservedBatchCode } from "@/lib/inventory/reserved-batch-code";
import { bogotaDayKey } from "@/lib/datetime/bogota";
import {
  createInventoryEntry,
  findInventoryEntryByIdempotencyKey,
  listInventoryEntries,
  type InventoryEntryListItem,
} from "@/server/repositories/inventory-entry.repository";
import {
  enqueuePendingAvailabilityNotification,
  type AvailabilityStatus,
} from "@/server/services/notification-outbox.service";

export type RegisterInventoryEntryInput = {
  productId: string;
  quantity: number;
  /**
   * Número de lote del proveedor. AUSENTE cuando la caja no lo trae impreso: en
   * ese caso el servicio deriva el código reservado que representa "sin lote"
   * (ver `lib/inventory/reserved-batch-code.ts`). Nunca se guarda una cadena
   * vacía: "" no es un lote llamado así, es la ausencia de lote.
   */
  batchCode?: string;
  /**
   * Vencimiento del lote, o `null` cuando no se conoce. NULL es DESCONOCIDO, no
   * vencido: el lote se sigue vendiendo y se consume al final. No se inventa una
   * fecha para poder guardarla.
   */
  expiresAt: Date | null;
  note?: string;
  createdById?: string | null;
  idempotencyKey?: string;
  /**
   * Laboratorio OBSERVADO al recibir la mercadería. Es un tercer eje, separado
   * del laboratorio SOLICITADO (`Pending`/`MissingItem.requestedLaboratoryId`)
   * y del de CATÁLOGO (`Product.laboratoryId`): lo que el cliente pidió, lo que
   * el catálogo dice y lo que bodega tuvo en la mano son tres hechos distintos
   * y ninguno puede escribir sobre otro.
   */
  receivedLaboratoryId?: string | null;
  /**
   * Laboratorio observado, escrito a mano por bodega.
   *
   * Se resuelve ACÁ ADENTRO y no en la Server Action a propósito. Resolverlo
   * afuera creaba el laboratorio antes de abrir la transacción: una entrada que
   * después se rechazaba —payload de idempotencia distinto, producto
   * inexistente, evidencia en conflicto— dejaba en el catálogo un laboratorio
   * que nadie pidió. Bodega tipeaba mal, la entrada se caía, y la basura
   * quedaba. Adentro de la transacción, el rollback se lo lleva.
   *
   * Se ignora si ya vino `receivedLaboratoryId`: elegir de la lista es más
   * específico que escribir el nombre.
   */
  receivedLaboratoryName?: string;
  /**
   * Las versiones del producto que el formulario le MOSTRO a la persona.
   *
   * Van OPCIONALES a proposito. El compare-and-set protege la decision de una
   * persona que leyo una pantalla y despues mando: existe una fotografia contra
   * la cual comparar. Un llamador programatico —el verificador de invariantes,
   * un test de reconciliacion— no leyo ninguna pantalla y no tiene nada que
   * declarar; exigirle un numero lo obligaria a inventarlo, y un numero
   * inventado que siempre coincide es un control que no controla nada.
   *
   * El unico camino que una persona usa es la Server Action, y ahi el esquema
   * las exige: la proteccion no es opcional donde importa.
   */
  expectedIdentityVersion?: number;
  expectedCatalogVersion?: number;
};

export type RegisterInventoryEntryResult = {
  entry: { id: string };
  allocatedMissingCount: number;
  /** @deprecated compatibility alias; counts allocation recipients. */
  closedMissingCount: number;
  idempotent: boolean;
  /**
   * El producto AUTORITATIVO contra el que se escribio.
   *
   * Ausente en un reintento idempotente: ahi no se escribio nada nuevo, y por
   * lo tanto no hay nada nuevo que auditar.
   */
  product?: EntryProductSnapshot;
};

export class IdempotencyPayloadConflictError extends Error {
  constructor() { super("idempotency key was already used for a different entry payload"); }
}

/**
 * El lote ya fue recibido con OTRO laboratorio.
 *
 * Se rechaza la entrada entera en vez de preservar o pisar la evidencia previa:
 * las dos alternativas silenciosas dejan un lote afirmando un laboratorio que
 * alguien no recibió, y eso no se descubre hasta que ya no se puede reconstruir.
 * Un rechazo es visible y se corrige en el momento.
 *
 * Lleva el NOMBRE del laboratorio y el código de lote —nunca ids internos—
 * porque el destinatario del mensaje es la persona que está cargando la caja.
 */
export class LaboratoryEvidenceConflictError extends Error {
  readonly batchCode: string;
  readonly existingLaboratoryName: string | null;

  constructor(params: { batchCode: string; existingLaboratoryName: string | null }) {
    super("batch already received with a different laboratory");
    this.batchCode = params.batchCode;
    this.existingLaboratoryName = params.existingLaboratoryName;
  }
}

/**
 * El lote ya fue recibido con OTRO vencimiento.
 *
 * Es el MISMO dilema que `LaboratoryEvidenceConflictError` y se resuelve igual,
 * por la misma razón. `upsertBatchQuantity` identifica al lote por
 * `(productId, batchCode)` y en la rama de actualización incrementa la cantidad
 * SIN tocar `expiresAt`, así que las dos alternativas silenciosas eran:
 * conservar la primera fecha —el lote termina afirmando un vencimiento que no
 * es el de la mercadería que acaba de entrar— o pisarla —y entonces lo que se
 * pierde es el de la que ya estaba—. Las dos dejan stock mezclado bajo una
 * fecha que no le corresponde a una parte, y eso no se descubre hasta que ya no
 * se puede reconstruir quién trajo qué.
 *
 * Se rechaza la entrada entera, y eso incluye los tres casos: dos fechas
 * distintas, conocida y después desconocida, y desconocida y después conocida.
 * Un vencimiento no se hereda ni se pierde en silencio.
 *
 * Si la caja trae de verdad otro vencimiento, es otro lote: se registra con otro
 * código.
 *
 * Lleva el CÓDIGO de lote y la fecha ya registrada —nunca ids internos— porque
 * el destinatario del mensaje es la persona que está cargando la caja.
 */
export class BatchExpiryConflictError extends Error {
  readonly batchCode: string;
  readonly existingExpiresAt: Date | null;

  constructor(params: { batchCode: string; existingExpiresAt: Date | null }) {
    super("batch already received with a different expiry");
    this.batchCode = params.batchCode;
    this.existingExpiresAt = params.existingExpiresAt;
  }
}

/**
 * El nombre de laboratorio no resolvió a un laboratorio propio.
 *
 * `findOrCreateLaboratory` devuelve `exact_name_exists` cuando el INSERT chocó
 * contra el `createCommandKey` y la identidad pedida no está en ninguna fila: el
 * laboratorio que vuelve es OTRO. Usarlo sería adjuntarle al lote un laboratorio
 * que bodega no escribió, que es exactamente el error que la evidencia de
 * laboratorio existe para impedir.
 */
/**
 * El producto todavía no tiene SKU (código de Orion).
 *
 * El SKU es lo único que ata un producto de la droguería con el mismo producto
 * en Orion. Cargar stock contra un producto sin identidad crea inventario que
 * después nadie puede cuadrar: existe acá y no existe allá, y la diferencia
 * aparece recién cuando alguien hace el conteo.
 *
 * El vendedor SÍ puede aplazarlo al tomar el pedido —tiene al cliente delante—,
 * pero ese aplazamiento se resuelve antes de que la mercadería toque el
 * inventario. Bodega tiene la caja en la mano, con el código impreso encima: es
 * el momento y la persona correctos para completarlo.
 *
 * Lleva el NOMBRE además del id porque el mensaje se le muestra a una persona,
 * y un cuid no le sirve para encontrar el producto en la pantalla.
 */
export class ProductIdentityRequiredError extends Error {
  readonly productId: string;
  readonly productName: string;

  constructor(params: { productId: string; productName: string }) {
    super("product has no Orion code");
    this.productId = params.productId;
    this.productName = params.productName;
  }
}

/**
 * El `productId` no corresponde a ninguna fila.
 *
 * Antes esto no se distinguia: la lectura devolvia `null`, el codigo seguia, y
 * la entrada moria mas adelante contra la clave foranea del lote con un error
 * generico. Quien recibia la caja leia "no se pudo registrar la entrada" y no
 * tenia forma de saber que el producto habia dejado de existir.
 */
export class ProductNotFoundError extends Error {
  readonly productId: string;

  constructor(productId: string) {
    super("product not found");
    this.productId = productId;
  }
}

/**
 * El producto cambio entre que la persona lo vio y que mando la entrada.
 *
 * Los DOS contadores viajan en el mismo error porque el desenlace es el mismo
 * —la entrada no se registra— y lo unico que cambia es QUE cambio. `kind` lo
 * dice; el resto del producto viaja entero para que el mensaje pueda nombrar el
 * SKU y la presentacion que la fila tiene AHORA, que es lo que la persona
 * necesita cotejar contra la caja que tiene en la mano.
 */
export class ProductVersionConflictError extends Error {
  constructor(
    readonly kind: "identity" | "catalog",
    readonly product: EntryProductSnapshot,
  ) {
    super(`product ${kind} version changed`);
  }
}

export class LaboratoryNameResolutionError extends Error {
  readonly requestedName: string;

  constructor(requestedName: string) {
    super("laboratory name resolved to a different laboratory");
    this.requestedName = requestedName;
  }
}

function requestFingerprint(data: RegisterInventoryEntryInput): string {
  return JSON.stringify({
    productId: data.productId, quantity: data.quantity, batchCode: data.batchCode,
    // `null` y no la clave omitida: una entrada sin vencimiento es una carga
    // distinta de una con fecha, y el reintento tiene que poder distinguirlas.
    expiresAt: data.expiresAt?.toISOString() ?? null,
    note: data.note?.trim() || null,
    createdById: data.createdById ?? null,
    // La clave se OMITE cuando no hay laboratorio, y va al final a propósito.
    // Así el JSON de toda entrada sin laboratorio es byte a byte el mismo de
    // antes de este campo: un reintento que cruce el despliegue compara contra
    // su fingerprint guardado y coincide, en vez de fallar por un conflicto de
    // payload que nadie provocó.
    ...(data.receivedLaboratoryId
      ? { receivedLaboratoryId: data.receivedLaboratoryId }
      : {}),
  });
}

function isUniqueConstraint(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

/**
 * Registra una entrada de inventario de forma atómica:
 * 1. Upsert del lote físico (ProductBatch) por (productId, batchCode).
 * 2. Inserción del registro de ledger (InventoryEntry).
 * 3. Cierre FIFO de faltantes abiertos para el producto (closeMissingItemsByEntry).
 *
 * Si cualquiera de las tres escrituras falla, Prisma revierte todo.
 */
/**
 * Convierte el nombre escrito por bodega en un `receivedLaboratoryId`.
 *
 * Devuelve la entrada intacta cuando no hay nombre que resolver o cuando ya
 * vino el id. La clave de comando lleva la identidad del laboratorio adentro
 * —vía `laboratoryCreateCommandKey`—, así que el mismo actor pidiendo el mismo
 * laboratorio reusa su propio comando en vez de chocar contra él.
 */
async function resolveLaboratoryName(
  data: RegisterInventoryEntryInput,
  tx: Prisma.TransactionClient,
): Promise<RegisterInventoryEntryInput> {
  const name = data.receivedLaboratoryName?.trim();
  if (data.receivedLaboratoryId || !name) return data;

  const resolved = await findOrCreateLaboratory(
    {
      name,
      commandKey: laboratoryCreateCommandKey(
        "auto",
        data.createdById ?? "sistema",
        name,
      ),
      needsReview: true,
    },
    tx,
  );

  // No se toma la fila a la fuerza: si el comando resolvió a otro laboratorio,
  // adjuntarlo sería inventar la evidencia.
  if (resolved.status === "exact_name_exists") {
    throw new LaboratoryNameResolutionError(name);
  }

  const { receivedLaboratoryName: _descartado, ...resto } = data;
  return { ...resto, receivedLaboratoryId: resolved.laboratory.id };
}

/**
 * El código con el que se va a guardar el lote.
 *
 * Sin número de lote informado, lo DERIVA el sistema: el código reservado lleva
 * el vencimiento adentro, así que dos cajas sin lote con fechas distintas son
 * dos lotes distintos y cada una queda en su fila con su propia fecha. Sin eso
 * caerían las dos en la misma fila y la segunda heredaría el vencimiento de la
 * primera, que es justo lo que no puede pasar.
 *
 * `||` y no `??`: el esquema del formulario ya normaliza el campo vacío a
 * `undefined`, pero un llamador programático puede mandar `""`, y una cadena
 * vacía tampoco es un lote.
 */
function resolveBatchCode(data: RegisterInventoryEntryInput): string {
  return data.batchCode || deriveReservedBatchCode(data.expiresAt);
}

/**
 * ¿Las dos fechas son el MISMO vencimiento?
 *
 * Se comparan por DÍA de calendario de Bogotá y no por instante. Un vencimiento
 * se dice por día —"vence el 31 de diciembre"—, y hay filas viejas guardadas
 * con hora: el formulario pedía `datetime-local` hasta el 2026-10-04. Comparar
 * instantes haría que recibir otra vez uno de esos lotes, con la fecha
 * correcta, se rechazara por una hora que nadie eligió.
 *
 * Dos desconocidos son el mismo vencimiento. Uno conocido y uno desconocido, no:
 * eso es exactamente el caso que se rechaza.
 */
function sameExpiryDay(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return bogotaDayKey(a) === bogotaDayKey(b);
}

export async function registerInventoryEntry(
  data: RegisterInventoryEntryInput,
): Promise<RegisterInventoryEntryResult> {
  try {
    return await prisma.$transaction(async (tx) => {
    // El laboratorio se resuelve PRIMERO y dentro de la transacción, para que
    // el fingerprint se calcule sobre el id ya resuelto: así el reintento de la
    // misma entrada produce el mismo fingerprint aunque el nombre se haya
    // escrito con otras mayúsculas, y cualquier fallo posterior revierte
    // también el laboratorio.
    const resolvedData = await resolveLaboratoryName(data, tx);
    // El código se resuelve ANTES del fingerprint: el reintento de una entrada
    // sin lote tiene que producir el mismo fingerprint que la primera.
    const batchCode = resolveBatchCode(resolvedData);
    const fingerprint = requestFingerprint({ ...resolvedData, batchCode });
    data = { ...resolvedData, batchCode };
    if (data.idempotencyKey) {
      const existing = await findInventoryEntryByIdempotencyKey(tx, data.idempotencyKey);
      if (existing) {
        if (existing.requestFingerprint !== undefined && existing.requestFingerprint !== fingerprint) throw new IdempotencyPayloadConflictError();
        return { entry: existing, allocatedMissingCount: 0, closedMissingCount: 0, idempotent: true };
      }
    }
    const idempotencyKey = data.idempotencyKey ?? crypto.randomUUID();

    // ----------------------------------------------------------------------
    // La fotografia del producto, bloqueada, ANTES de escribir una sola fila.
    //
    // Va DESPUES del chequeo de idempotencia a proposito. Un reintento de una
    // entrada YA confirmada no es una decision nueva: es la misma, que ya se
    // tomo y ya se escribio. Validarle las versiones contra el producto de hoy
    // convertiria un reintento legitimo —el navegador que reenvia, la red que
    // se corto— en un conflicto inventado, y la persona vería un error por una
    // entrada que en realidad esta registrada.
    //
    // Y va ANTES de tocar el lote porque comprobar despues de escribir no
    // comprueba nada: para cuando se detectara el conflicto, el stock ya
    // existiria. El `FOR UPDATE` cierra la ventana entre la comprobacion y la
    // escritura; el `throw` revierte la transaccion entera.
    // ----------------------------------------------------------------------
    const product = await lockProductForEntry(tx, data.productId);
    if (!product) throw new ProductNotFoundError(data.productId);
    if (!product.orionCode) {
      throw new ProductIdentityRequiredError({
        productId: product.id,
        productName: product.name,
      });
    }
    // La identidad primero: si cambio el SKU, eso es lo que hay que nombrar.
    if (
      data.expectedIdentityVersion !== undefined &&
      data.expectedIdentityVersion !== product.identityVersion
    ) {
      throw new ProductVersionConflictError("identity", product);
    }
    if (
      data.expectedCatalogVersion !== undefined &&
      data.expectedCatalogVersion !== product.catalogVersion
    ) {
      throw new ProductVersionConflictError("catalog", product);
    }

    // ----------------------------------------------------------------------
    // Las dos evidencias del lote —laboratorio y vencimiento— se deciden ANTES
    // de tocar el lote y bajo el MISMO candado.
    //
    // POR QUÉ UN CANDADO Y NO UNA LECTURA. Leer y después escribir es una
    // carrera: dos recepciones simultáneas del mismo lote nuevo leerían las dos
    // que todavía no existe, las dos se creerían la primera, y la segunda
    // heredaría o pisaría la fecha de la primera en silencio — exactamente lo
    // que la regla de conflicto existe para impedir.
    //
    // El candado es el que YA vive en `lockBatchForEntry`: un advisory lock
    // TRANSACCIONAL colgado del par `(productId, batchCode)`, que existe aunque
    // la fila no exista y se suelta al cerrar la transacción. Se eligió ese y no
    // el helper de violación de unicidad (`isUniqueViolation`, en
    // `lot.repository`) porque P2002 solo avisa DESPUÉS de intentar escribir, y
    // para entonces ya no se le puede nombrar a la persona la fecha que el lote
    // tenía registrada — que es lo único que le sirve del mensaje. Tampoco se
    // suman los dos: una sola carrera, un solo mecanismo.
    //
    // El candado se tomaba solo cuando la recepción informaba un laboratorio.
    // Ahora se toma SIEMPRE, porque la regla del vencimiento aplica a toda
    // entrada.
    //
    // Cualquiera de los dos rechazos revierte la transacción ENTERA: no queda
    // la fila de ledger, ni la asignación FIFO, ni el laboratorio recién
    // creado. Un rechazo a medias sería peor que el conflicto.
    // ----------------------------------------------------------------------
    const locked = await lockBatchForEntry(tx, {
      productId: data.productId,
      batchCode,
    });

    if (locked && !sameExpiryDay(locked.expiresAt, data.expiresAt)) {
      throw new BatchExpiryConflictError({
        batchCode,
        existingExpiresAt: locked.expiresAt,
      });
    }

    // `null` en el lote es AUSENCIA de evidencia, no un valor en conflicto:
    // un lote histórico acepta la primera observación que llegue.
    if (
      data.receivedLaboratoryId &&
      locked?.receivedLaboratoryId &&
      locked.receivedLaboratoryId !== data.receivedLaboratoryId
    ) {
      throw new LaboratoryEvidenceConflictError({
        batchCode,
        existingLaboratoryName: locked.receivedLaboratoryName,
      });
    }

    const batch = await upsertBatchQuantity(tx, {
      productId: data.productId,
      batchCode,
      expiresAt: data.expiresAt,
      quantity: data.quantity,
      ...(data.receivedLaboratoryId
        ? { receivedLaboratoryId: data.receivedLaboratoryId }
        : {}),
    });

    const entry = await createInventoryEntry(tx, {
      productId: data.productId,
      quantity: data.quantity,
      note: data.note,
      createdById: data.createdById,
      idempotencyKey,
      requestFingerprint: fingerprint,
    });

    // Compatibilidad segura con recepciones heredadas que no traen operation id.
    if (!data.idempotencyKey) {
      const closedIds = await closeMissingItemsByEntry(tx, { productId: data.productId, availableQuantity: data.quantity });
      await markReportsReceivedByMissingItemIds(tx, closedIds);
      return { entry, allocatedMissingCount: closedIds.length, closedMissingCount: closedIds.length, idempotent: false, product };
    }
    // FIFO cuantitativo: se bloquean los faltantes del producto y cada unidad de
    // esta entrada queda ligada a exactamente un faltante. Los parciales quedan
    // registrados, nunca se salta una necesidad sin consumir cantidad.
    // SOLO faltantes ligados a una venta: uno informativo (`originId` nulo) no
    // tiene a nadie esperando y no puede quedarse con stock de un pendiente.
    const rows = await tx.$queryRaw<Array<{
      id: string; quantity: number; orderedQuantity: number | null; receivedQuantity: number; originId: string | null;
    }>>`SELECT id, quantity, "orderedQuantity", "receivedQuantity", "originId" FROM missing_items WHERE "productId" = ${data.productId} AND status IN ('FALTANTE', 'PEDIDO', 'EN_BODEGA') AND "originId" IS NOT NULL AND "receivedQuantity" < CASE WHEN "originId" IS NULL THEN COALESCE("orderedQuantity", quantity) ELSE quantity END ORDER BY "createdAt" ASC, id ASC FOR UPDATE`;
    let remaining = data.quantity;
    let reservedQuantity = 0;
    let allocatedMissingCount = 0;
    const closedMissingIds: string[] = [];
    for (const item of rows) {
      if (remaining === 0) break;
      const needed = item.originId === null ? (item.orderedQuantity ?? item.quantity) : item.quantity;
      const allocated = Math.min(remaining, needed - item.receivedQuantity);
      if (allocated <= 0) continue;
      const receivedQuantity = item.receivedQuantity + allocated;
      await tx.inventoryAllocation.create({ data: {
        inventoryEntryId: entry.id, missingItemId: item.id, pendingId: item.originId,
        quantity: allocated,
      }});
      // Una recepción PARCIAL no cambia de estado (D10). Antes pasaba a
      // EN_BODEGA, y eso le daba dos significados al mismo valor: "recepción
      // intentada, no confirmada" —lo que escribe `markMissingItemArrived`, y
      // lo que además le avisa al pendiente del vendedor— y "recibido a
      // medias". Un parcial YA se confirmó, así que el ítem sigue siendo lo
      // que era: un PEDIDO al que le falta mercadería, o un FALTANTE que nadie
      // pidió pero al que igual le entró stock. Solo completarlo lo cierra.
      await tx.missingItem.update({ where: { id: item.id }, data: {
        receivedQuantity,
        ...(receivedQuantity === needed ? { status: "RECIBIDO" as const } : {}),
      }});
      if (item.originId) {
        const pending = await tx.pending.findUniqueOrThrow({ where: { id: item.originId }, select: { quantity: true, inventoryReadyQuantity: true, reservedInventoryQuantity: true } });
        const inventoryReadyQuantity = Math.min(pending.quantity, pending.inventoryReadyQuantity + allocated);
        const availabilityStatus: AvailabilityStatus =
          inventoryReadyQuantity === pending.quantity ? "DISPONIBLE_COMPLETO" : "DISPONIBLE_PARCIAL";
        await tx.pending.update({ where: { id: item.originId }, data: {
          inventoryReadyQuantity,
          reservedInventoryQuantity: pending.reservedInventoryQuantity + allocated,
          availabilityStatus,
        }});
        // Avisa al vendedor que su pendiente ya tiene stock disponible. DENTRO
        // de la transacción: si el batch se revierte, la notificación también.
        await enqueuePendingAvailabilityNotification(
          { pendingId: item.originId, availabilityStatus },
          tx,
        );
        await reserveBatchForPending(tx, item.originId, batch.id, allocated);
      }
      remaining -= allocated;
      // A manual MissingItem has no customer Pending. Receiving it closes the
      // purchasing/report workflow but leaves the physical units sellable.
      if (item.originId) reservedQuantity += allocated;
      allocatedMissingCount += 1;
      if (receivedQuantity === needed) closedMissingIds.push(item.id);
    }
    if (reservedQuantity > 0) {
      await reserveReceivedBatchQuantity(tx, batch.id, reservedQuantity);
    }
    await markReportsReceivedByMissingItemIds(tx, closedMissingIds);
    return { entry, allocatedMissingCount, closedMissingCount: allocatedMissingCount, idempotent: false, product };
    });
  } catch (error) {
    // A simultaneous retry can pass the preflight read in both transactions.
    // The unique index chooses one winner; return that committed ledger entry.
    if (data.idempotencyKey && isUniqueConstraint(error)) {
      const entry = await findInventoryEntryByIdempotencyKey(prisma, data.idempotencyKey);
      if (entry) {
        if (entry.requestFingerprint !== undefined && entry.requestFingerprint !== requestFingerprint(data)) throw new IdempotencyPayloadConflictError();
        return { entry, allocatedMissingCount: 0, closedMissingCount: 0, idempotent: true };
      }
    }
    throw error;
  }
}

// Boundary de lectura para la UI — la página delega acá, nunca al repo directo.
export function getInventoryEntries(params: {
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<InventoryEntryListItem>> {
  return listInventoryEntries(params);
}

export function getArrivedMissingItems() {
  return listArrivedMissingItems();
}

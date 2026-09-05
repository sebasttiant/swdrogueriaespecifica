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
  type PendingIdentityDeferral,
} from "@/lib/generated/prisma/client";
import {
  cancelPending,
  countOpenPendings,
  countOverduePendings,
  countUpcomingPendings,
  createPending,
  createPendingDelivery,
  findPendingByIdempotencyKey,
  findPendingInView,
  lockPendingForUpdate,
  listPendings,
  listPendingIdentityQueue,
  listUrgentPendings,
  listUsedZones,
  updatePendingAfterDelivery,
  updatePendingManagementStatus,
  type PendingAxisFilters,
  type PendingIdentityQueueRow,
  type PendingListItem,
  type PendingScope,
  lockPendingForEdit,
  updatePendingDetails,
  type PendingForEdit,
} from "@/server/repositories/pending.repository";
import { createProduct } from "@/server/repositories/product.repository";
import { normalizeOrionCode } from "@/server/domain/catalog/sku-identity";
import { createMissingItem } from "@/server/repositories/missing-item.repository";
import {
  claimableStockForPending,
  consumePendingReservations,
  releasePendingReservations,
  lockReservedQuantityForPending,
} from "@/server/repositories/product-batch.repository";
import { prisma } from "@/lib/db/prisma";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  recordAuditInTransaction,
  type TransactionalAuditWriter,
} from "@/server/services/transactional-audit.service";
import type { Paginated } from "@/lib/pagination";
import {
  can,
  seesAllPendings,
  USER_ROLES,
  type PendingActionScope,
} from "@/lib/auth/permissions";
import type { SessionRole } from "@/lib/auth/session";
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
//
// `orionCode` viaja en el ALTA del producto, no en un update posterior: un
// producto que nace con su identidad nunca existe sin ella, ni por un instante.
export type ManualProductInput = {
  name: string;
  unit: string;
  orionCode?: string;
};

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
  identitySkippedReason?: PendingIdentityDeferral;
  identitySkippedNote?: string;
  // Clave del INTENTO. Obligatoria para toda alta nueva; las filas históricas
  // siguen nullable únicamente por compatibilidad de datos.
  idempotencyKey: string;
  // T3: laboratorio solicitado por el cliente. Requerido en captura nueva.
  requestedLaboratoryId?: string;
};

/**
 * El código de Orion del producto manual ya es de OTRO producto.
 *
 * Lleva al dueño porque nombrarlo es lo único que convierte el rechazo en una
 * salida: sin el nombre, al operador solo le queda adivinar. El código NUNCA
 * se mueve —eso sería RELINK, una decisión explícita que la captura no tiene.
 */
export class ManualProductIdentityConflictError extends Error {
  constructor(readonly holder: { id: string; name: string }) {
    super(`orion code already belongs to product ${holder.id}`);
    this.name = "ManualProductIdentityConflictError";
  }
}

export class PendingIdempotencyPayloadConflictError extends Error {
  constructor() {
    super("idempotency key was already used for a different pending payload");
  }
}

export type RegisterPendingDependencies = {
  writeAudit?: TransactionalAuditWriter;
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
 * UN pendiente de la vista, buscado por id, con la MISMA autorización que el
 * listado: recorte por dueño y minimización de identidad del cliente.
 *
 * Lo usa Revisión de pendientes para poder mostrar la fila que alguien vino a
 * ver cuando quedó fuera de la página cargada. Sin esto, el enlace del aviso de
 * llegada apunta a un ancla inexistente en cuanto el pendiente baja del puesto
 * veinte, y el navegador no hace nada — el mismo síntoma que ya arreglamos una
 * vez, reapareciendo solo con los pedidos más viejos.
 *
 * `canViewCustomerIdentity` es obligatorio por el mismo motivo que en
 * `getPendings`: que falte tiene que ser un error de tipos, nunca una fuga.
 */
export async function getPendingInView(params: {
  id: string;
  canViewCustomerIdentity: boolean;
  scope?: PendingScope;
  ownerId?: string;
  axes?: PendingAxisFilters;
}): Promise<PendingListItem | null> {
  const { canViewCustomerIdentity, ...viewParams } = params;
  const found = await findPendingInView(viewParams);
  if (!found) return null;
  return minimizeCustomerIdentity([found], canViewCustomerIdentity)[0] ?? null;
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
  deps: RegisterPendingDependencies = {},
): Promise<CreatePendingResult> {
  if (data.identitySkippedNote?.trim() && !data.identitySkippedReason) {
    throw new Error("identitySkippedNote requires identitySkippedReason");
  }
  data = withNormalizedIdentity(data);
  const fingerprint = requestFingerprint(data);
  // Camino barato: el intento ya tiene su pendiente. Ni transacción ni lock.
  const existing = await findPendingByIdempotencyKey(data.idempotencyKey);
  if (existing) return replayRegistration(existing, fingerprint);

  try {
    return await createPendingRegistration(data, fingerprint, deps);
  } catch (error) {
    // Camino correcto: perdimos la carrera contra otro envío con la MISMA clave.
    // El pendiente existe —lo creó el otro— así que esto es un éxito, no un
    // fallo: devolver error acá haría que el operador reintente algo ya hecho.
    if (isIdempotencyConflict(error)) {
      const winner = await findPendingByIdempotencyKey(data.idempotencyKey);
      if (winner) return replayRegistration(winner, fingerprint);

      // P2002 sin ganador por esta clave. NO se asume cuál índice fue: esta
      // transacción puede violar varios únicos —el `code` del producto manual
      // también lo es, y se genera acá con un sufijo aleatorio que puede
      // colisionar—, así que deducirlo por descarte sería frágil.
      //
      // Tampoco se mira `meta.target`: en Prisma 7 no es de fiar y el resto
      // del repositorio ya detecta P2002 por estructura. Se resuelve
      // preguntándole a la base quién tiene ese código. Si nadie lo tiene, el
      // conflicto fue de otro índice y el error sigue de largo sin disfrazarse.
      const holder = await holderOfManualOrionCode(data);
      if (holder) throw new ManualProductIdentityConflictError(holder);
    }
    throw error;
  }
}

/**
 * Deja la identidad del alta manual en su forma canónica, o falla.
 *
 * Este service se exporta y se llama directo, así que no puede confiar en que
 * alguien más ya validó: valida su propia entrada, igual que hace con la nota
 * huérfana unas líneas más arriba.
 *
 * El vacío es AUSENCIA, no un código. Guardarlo sería peor que rechazarlo: la
 * cadena vacía ocuparía la ranura del índice único y toda alta manual sin
 * código posterior chocaría contra un P2002 sin dueño a quien señalar —un
 * fallo genérico, irrecuperable, para siempre—.
 */
function withNormalizedIdentity(data: RegisterPendingInput): RegisterPendingInput {
  if (!data.manual) return data;

  const raw = data.manual.orionCode?.trim();
  // Sin código: no hay nada que canonizar y el aplazamiento decide solo.
  if (!raw) {
    return { ...data, manual: { ...data.manual, orionCode: undefined } };
  }

  if (data.identitySkippedReason) {
    // Un aplazamiento afirma que NO se pudo conseguir el código. Junto a un
    // código que sí vino, esa afirmación es falsa —y queda guardada como
    // historia permanente del pendiente, contradiciendo al producto para
    // siempre. Es una contradicción, no una preferencia a resolver.
    throw new Error("manual.orionCode and identitySkippedReason are exclusive");
  }

  // Tira `SkuIdentityError` ante espacios internos o exceso de longitud. Se
  // usa la regla del DOMINIO y no una copia: dos definiciones de qué es un
  // código válido terminan aceptando lo que la base rechaza.
  return { ...data, manual: { ...data.manual, orionCode: normalizeOrionCode(raw) } };
}

/** El producto que hoy tiene el código que el alta manual quiso usar, si hay. */
async function holderOfManualOrionCode(
  data: RegisterPendingInput,
): Promise<{ id: string; name: string } | null> {
  // Rama catálogo: esta transacción NO escribió ningún `orionCode`, así que
  // un P2002 de acá nunca es un conflicto de identidad por más que el llamador
  // haya adjuntado un `manual` que no se usó. Sin esta guarda, la exhaustividad
  // dependería de que nadie mande las dos cosas a la vez.
  if (data.productId) return null;

  const orionCode = data.manual?.orionCode;
  if (!orionCode) return null;
  // Después del rollback, nunca dentro de la transacción abortada: ahí
  // PostgreSQL responde 25P02 y taparía el conflicto real.
  return prisma.product.findUnique({
    where: { orionCode },
    select: { id: true, name: true },
  });
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
      ? {
          name: data.manual.name.trim(),
          unit: data.manual.unit.trim(),
          // El código forma parte de QUÉ se pidió crear: sin él, reintentar la
          // misma alta con OTRO código pasaría por réplica del intento anterior
          // y devolvería el producto viejo como si nada hubiera cambiado.
          //
          // Se agrega SOLO cuando viene, igual que los campos de aplazamiento
          // en 1c. Emitirlo siempre —aunque fuera `null`— cambiaría la huella
          // de todo pendiente manual ya guardado, y el primer reintento de uno
          // de ellos se leería como "misma clave, otros datos": un conflicto
          // inventado sobre un alta que nadie modificó.
          ...(data.manual.orionCode ? { orionCode: data.manual.orionCode } : {}),
        }
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
    ...(data.identitySkippedReason
      ? {
          identitySkippedReason: data.identitySkippedReason,
          identitySkippedNote: data.identitySkippedNote?.trim() || null,
        }
      : {}),
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
  deps: RegisterPendingDependencies,
): Promise<CreatePendingResult> {
  return prisma.$transaction(async (tx) => {
    const writeAudit = deps.writeAudit ?? recordAuditInTransaction;
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
          // Tener código de Orion NO lo vuelve un producto curado: sigue
          // marcado para revisión como cualquier alta manual.
          orionCode: data.manual.orionCode ?? null,
          // Un producto CON código y sin estado sería un tercer estado que ni
          // PROVISIONAL_REVIEW ni CONFIRMED cubren, y la cola de revisión de
          // identidad se lee justamente por este campo.
          ...(data.manual.orionCode ? { skuStatus: "CONFIRMED" as const } : {}),
        },
        tx,
      );
      productId = createdProduct.id;

      if (data.manual.orionCode) {
        // Quién ató este código, cuándo y por qué camino. El mismo código
        // entrando por `linkOrionCodeAtCapture` deja este rastro; entrando por
        // el alta manual no dejaba ninguno, y el día que resulte equivocado no
        // habría a quién preguntarle. Va en la MISMA transacción: un vínculo
        // sin asiento no es un vínculo a medias, es un vínculo sin testigo.
        await writeAudit(tx, {
          action: AUDIT_ACTIONS.SKU_ORION_LINK,
          module: AUDIT_MODULES.PRODUCTOS,
          entity: "Product",
          entityId: createdProduct.id,
          // El producto NACE con el código: no hubo un estado anterior que
          // registrar, y por eso `before` va nulo en vez de inventado.
          before: { orionCode: null, identityVersion: null },
          after: {
            orionCode: createdProduct.orionCode,
            identityVersion: createdProduct.identityVersion,
          },
          context: { userId: data.createdById ?? null },
        });
      }
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
        identitySkippedReason: data.identitySkippedReason,
        identitySkippedNote: data.identitySkippedNote,
        requestedLaboratoryId: data.requestedLaboratoryId,
      }, tx,
    );
    if (data.identitySkippedReason) {
      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PENDING_IDENTITY_DEFERRED,
        module: AUDIT_MODULES.PENDIENTES,
        entity: "Pending",
        entityId: pending.id,
        after: { productId, reason: data.identitySkippedReason },
        context: { userId: data.createdById ?? null },
      });
    }
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
    // El techo FÍSICO, leído bajo el mismo lock que el pendiente. Va antes de
    // validar porque la regla lo necesita: sin este dato, el único techo era el
    // compromiso comercial, y por ahí salieron cinco unidades que nunca
    // entraron al inventario.
    const reservedQuantity = await lockReservedQuantityForPending(tx, current.id);

    const rejection = validateDelivery({
      status: current.status,
      quantity: current.quantity,
      deliveredQuantity: current.deliveredQuantity,
      cancelledQuantity: current.cancelledQuantity,
      deliverQuantity: input.quantity,
      invoicedQuantity: current.invoicedQuantity,
      customerStatus: current.customerStatus,
      reservedQuantity,
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

export type InvoicePendingInput = {
  id: string;
  actorId: string;
  /**
   * Sobre qué pendientes puede facturar este actor. Se deriva UNA vez, en
   * `invoiceScopeFor`, y llega acá explícito. Antes viajaba como
   * `canManageAll?: boolean`, un booleano cuyo significado cambiaba según el
   * rol que lo mandaba: no distinguía "no tiene autoridad" de "tiene autoridad
   * acotada a lo suyo", así que un rol sin permiso de facturar y un vendedor
   * sobre un pendiente ajeno producían exactamente el mismo `false`.
   */
  scope: PendingActionScope;
  quantity?: number;
};

export type InvoicePendingRejection =
  | "NOT_AUTHORIZED"
  | "NOT_OWNER"
  | "ALREADY_TERMINAL"
  | "INVALID_QUANTITY"
  | "NO_STOCK";

/**
 * Facturarle al cliente lo que ya llegó de su pendiente.
 *
 * STOCK. Hasta el 2026-10-04 esto no miraba disponibilidad: la migración
 * `20260731010000_invoice_before_arrival` había sacado a propósito el CHECK
 * `invoicedQuantity <= inventoryReadyQuantity` con el argumento de que factura
 * la persona mirando su caja y el software se entera después. En la práctica el
 * resultado fue el opuesto: gerencia veía el botón "Facturar" en pendientes sin
 * una sola unidad en bodega, y la pantalla no distinguía un pedido listo de uno
 * que todavía nadie había recibido. La regla vuelve, y vuelve acá —en el
 * service, adentro de la transacción— porque es la única capa que ven por igual
 * la pantalla, la Server Action invocada directo y cualquier futuro cliente.
 *
 * CUÁNTO SE PUEDE FACTURAR. El techo es el menor de dos números, y hay que
 * respetar los DOS:
 *
 *   - lo que el cliente todavía no tiene facturado  (`quantity - invoicedQuantity`)
 *   - lo que llegó y todavía no se facturó          (`inventoryReadyQuantity - invoicedQuantity`)
 *
 * `inventoryReadyQuantity` es la cantidad canónica de stock facturable: es lo
 * que la recepción de mercadería reserva PARA ESTE PENDIENTE
 * (`inventory-entry.service.ts`), no el inventario global del producto. Usar el
 * inventario del catálogo dejaría que dos pendientes del mismo producto
 * facturaran las mismas unidades.
 *
 * CONCURRENCIA. `lockOwnedPending` hace `SELECT ... FOR UPDATE` sobre la fila,
 * así que dos facturas simultáneas sobre el mismo pendiente se serializan: la
 * segunda lee el `invoicedQuantity` que dejó la primera y se rechaza sola si ya
 * no queda stock. Sin ese lock, las dos leerían el mismo cero y facturarían el
 * doble de lo que llegó.
 */
export async function invoicePending(
  input: InvoicePendingInput,
  now = new Date(),
): Promise<InvoicePendingRejection | null> {
  // El rol que no factura se rechaza antes de tocar la base: no hay fila que
  // mirar ni lock que tomar si la autoridad no existe.
  if (input.scope === "none") return "NOT_AUTHORIZED";

  return prisma.$transaction(async (tx) => {
    const pending = await lockPendingForUpdate(tx, input.id);
    if (!pending) throw new Error("Pending not found");
    if (input.scope === "own" && pending.createdById !== input.actorId) {
      return "NOT_OWNER";
    }
    if (pending.customerStatus === "ENTREGADO" || pending.customerStatus === "CANCELADO") {
      return "ALREADY_TERMINAL";
    }

    const pendingToInvoice = Math.max(pending.quantity - pending.invoicedQuantity, 0);
    const stockToInvoice = Math.max(
      pending.inventoryReadyQuantity - pending.invoicedQuantity,
      0,
    );

    // Sin mercadería cargada no hay nada que facturar, y decirlo con su propio
    // código evita que la pantalla muestre "revisá la cantidad" cuando la
    // cantidad estaba bien y lo que falta es el stock.
    if (stockToInvoice <= 0) return "NO_STOCK";

    // Sin cantidad explícita se factura todo lo facturable, que es el menor de
    // los dos techos y no "todo lo que el cliente pidió".
    const quantity = input.quantity ?? Math.min(pendingToInvoice, stockToInvoice);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > pendingToInvoice) {
      return "INVALID_QUANTITY";
    }
    if (quantity > stockToInvoice) return "NO_STOCK";

    await tx.pending.update({
      where: { id: pending.id },
      data: {
        customerStatus: "FACTURADO",
        invoicedQuantity: pending.invoicedQuantity + quantity,
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

// --------------------------------------------------------------------------
// Cola de identidad pendiente (S2b · 2-A) — el borde autorizado.
//
// Acá se decide QUIÉN ve QUÉ, una sola vez, leyendo la política de
// `permissions.ts`. El repositorio recibe el alcance ya resuelto y no vuelve a
// opinar: dos lugares decidiendo lo mismo es cómo una de las dos copias
// termina filtrando, y filtrando en silencio.
// --------------------------------------------------------------------------

/** Un rol sin autoridad para leer la cola. Se lanza ANTES de consultar. */
export class PendingIdentityQueueForbiddenError extends Error {
  constructor(readonly role: SessionRole) {
    super(`El rol ${role} no puede leer la cola de identidad pendiente.`);
    this.name = "PendingIdentityQueueForbiddenError";
  }
}

/**
 * La cola de productos que todavía esperan su código de Orion.
 *
 * Alcance (D8), derivado de `seesAllPendings` y no de una lista nueva de
 * roles: gerencia —SUPERADMIN, ADMIN, SUPERVISOR— ve la cola entera; quien
 * captura y no la ve entera —OPERADOR, BODEGA— ve solo lo que cargó.
 *
 * La lee QUIEN PUEDE RESOLVERLA. Completar una fila es asignarle el código a
 * un producto YA catalogado, y eso exige `canFixProductIdentity`: la tienen
 * SUPERADMIN, ADMIN, SUPERVISOR y BODEGA. OPERADOR no, así que se lo rechaza
 * en el borde en vez de mostrarle una lista sobre la que no puede actuar. Su
 * `canLinkProductIdentity` cubre otro flujo —pegar el código mientras captura
 * un pendiente nuevo—, no esta cola.
 *
 * Es de LECTURA: no marca, no limpia y no toca el historial del aplazamiento.
 */
export async function getPendingIdentityQueue(params: {
  role: SessionRole;
  userId: string;
  cursor?: string | null;
  take?: number;
}): Promise<Paginated<PendingIdentityQueueRow>> {
  // La capacidad que decide es la de RESOLVER, no la de ver el módulo:
  // `canViewPendientes` la tienen los cinco roles, así que como guarda no
  // decidiría nada y taparía la pregunta de para quién es esta cola.
  //
  // El rol se coteja contra `USER_ROLES` ANTES de preguntarle a `can`, porque
  // `can` indexa el mapa de capacidades sin defenderse: con un rol que no
  // existe revienta con un TypeError en vez de responder que no. Un permiso
  // tiene que resolverse en una DECISIÓN, no en un choque —y un choque, si
  // alguien lo atrapa, no se distingue de un fallo de infraestructura.
  const known = (USER_ROLES as readonly string[]).includes(params.role);
  if (!known || !can(params.role, "canFixProductIdentity")) {
    throw new PendingIdentityQueueForbiddenError(params.role);
  }

  // El repositorio lee `ownerId: undefined` como COLA ENTERA. Si un llamador
  // olvida el `userId` de un rol acotado, el descuido se convertiría en una
  // fuga silenciosa: más filas, sin error y sin rastro. Falla fuerte, igual
  // que `getPendingDashboard` con su alcance de dueño.
  const seesAll = seesAllPendings(params.role);
  if (!seesAll && !params.userId) {
    throw new Error("getPendingIdentityQueue: el alcance propio exige userId");
  }

  return listPendingIdentityQueue({
    ownerId: seesAll ? undefined : params.userId,
    cursor: params.cursor,
    take: params.take,
  });
}

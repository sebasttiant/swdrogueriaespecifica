"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { checkCapability, requireCapability } from "@/lib/auth/require-role";
import { can } from "@/lib/auth/permissions";
import { hashEmail, maskPhone, describeText } from "@/lib/observability/redaction";
import { newSupportCode } from "@/lib/observability/support-code";
import {
  describeError,
  logPendingEvent,
  PENDING_STAGES,
  type PendingLogEvent,
  type SubmitMethod,
} from "@/lib/observability/pending-log";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import {
  cancelPendingCommitment,
  resolvePartialPending,
  updatePending,
  deliverPending,
  contactPending,
  invoicePending,
  PendingIdempotencyPayloadConflictError,
  registerPending,
  setPendingManagementStatus,
} from "@/server/services/pending.service";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { DeliveryRejection } from "@/features/pendientes/delivery-rules";
import {
  pendingCancelSchema,
  pendingCreateSchema,
  pendingDeliverSchema,
  pendingManagementStatusSchema,
  pendingUpdateSchema,
} from "@/features/pendientes/schema";

// --------------------------------------------------------------------------
// Server Actions de pendientes (finas): Zod → requireCapability → service → audit.
// Registrar un pendiente requiere un usuario activo en DB (DB-authoritative guard).
// Un token JWT válido de un usuario desactivado es rechazado. El acceso se decide
// por capability (`canCreatePendientes`), no por una lista fija de roles; todos
// deben tener active=true en la DB.
// La regla de déficit (genera faltante) vive en el service; acá solo auditamos
// cada efecto de forma best-effort.
// --------------------------------------------------------------------------

export type PendingFormState = {
  error: string | null;
  ok: boolean;
  /**
   * Código dictable del intento (`PND-K7M2QX`). Se muestra al operador cuando
   * algo falla y es el `correlationId` con el que se busca el intento en el log.
   */
  supportCode?: string | null;
  /**
   * Eco EXACTO de lo que se envió, presente SOLO cuando `ok === false`.
   *
   * React limpia los campos no controlados de un `<form action>` en cuanto la
   * acción resuelve —resuelva con éxito o con error—, así que sin este eco no
   * queda en ninguna parte lo que la persona había escrito y hay que volver a
   * tipear todo para reintentar. En éxito va ausente a propósito: es lo que hace
   * que el formulario quede en blanco para el pendiente siguiente.
   */
  values?: PendingSubmittedValues | null;
  /**
   * Identidad del resultado. Cambia en CADA respuesta, y el formulario la usa
   * como `key` para remontar sus campos. Es lo que vuelve explícito el contrato
   * "se limpia solo en éxito" en vez de depender del reset automático de React.
   */
  submissionId?: string;
  /**
   * El operador escribió un valor total que el sistema guardó como DESCONOCIDO.
   *
   * Pasa cuando tipea "0": en el mostrador eso es "no sé cuánto sale", y el
   * pendiente entra igual con el precio en NULL en vez de frenarlo con un error.
   * Pero escribió una cosa y se guardó otra, así que hay que decírselo: sin este
   * aviso, alguien puede jurar que cargó el precio y el listado decir que no, sin
   * forma de saber quién tiene razón.
   */
  savedWithoutTotalAmount?: boolean;
};

/**
 * Los campos del formulario tal como viajaron, en texto plano de FormData.
 *
 * Texto y no valores parseados a propósito: lo que hay que devolverle a la
 * persona es LO QUE ESCRIBIÓ, no nuestra interpretación. Si tipeó "45.000" y el
 * parser lo leyó mal, devolverle "45000" —o peor, vacío— le esconde el dato que
 * necesita corregir.
 */
export type PendingSubmittedValues = {
  productId: string;
  manualName: string;
  manualUnit: string;
  manualMode: string;
  quantity: string;
  promisedAt: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  note: string;
  zone: string;
  totalAmount: string;
  paidAmount: string;
  idempotencyKey: string;
};

const SUBMITTED_FIELDS = [
  "productId",
  "manualName",
  "manualUnit",
  "manualMode",
  "quantity",
  "promisedAt",
  "customerName",
  "customerPhone",
  "customerAddress",
  "note",
  "zone",
  "totalAmount",
  "paidAmount",
  "idempotencyKey",
] as const satisfies readonly (keyof PendingSubmittedValues)[];

/** Lee un campo como texto. `null`/`File` se normalizan a cadena vacía. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function collectSubmittedValues(formData: FormData): PendingSubmittedValues {
  const values = {} as PendingSubmittedValues;
  for (const field of SUBMITTED_FIELDS) values[field] = text(formData, field);
  return values;
}

/**
 * Clave de idempotencia aceptable: un UUID generado por el formulario.
 *
 * Se valida la FORMA antes de usarla porque llega del cliente y termina en una
 * columna con índice único. Una clave arbitraria y larga elegida por quien envía
 * el formulario le dejaría fijar a mano contra qué fila colisiona.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idempotencyKeyFrom(raw: string): string | null {
  return UUID_PATTERN.test(raw) ? raw.toLowerCase() : null;
}

function logPendingError(correlationId: string | null, error: unknown): void {
  const { errorClass, errorCode } = describeError(error);
  console.error("[pendientes] operation_failed", {
    correlationId,
    errorClass,
    errorCode,
  });
}

function submitMethodFrom(raw: string): SubmitMethod {
  return raw === "enter" || raw === "click" ? raw : "unknown";
}

/**
 * El primer problema concreto que encontró el validador, en palabras del negocio.
 *
 * Los mensajes del schema ya están escritos para el mostrador ("El valor total
 * debe ser mayor a cero..."), así que se muestran tal cual. Se elige el primero
 * y no todos porque en un formulario de trece campos una lista de errores se
 * lee menos que una instrucción.
 */
function firstIssueMessage(error: { issues: readonly { message: string }[] }): string {
  return error.issues[0]?.message ?? "Revisá los datos del pendiente.";
}

/**
 * Violación de una restricción CHECK de la base (SQLSTATE 23514).
 *
 * Importa distinguirla porque es un error DETERMINISTA: el dato cargado no puede
 * entrar, y va a fallar igual las veces que se reintente. Tratarla como un fallo
 * transitorio —diciendo "Intentá de nuevo"— es lo que hizo que alguien reintente
 * siete veces seguidas un registro que nunca iba a entrar.
 */
function isCheckConstraintViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Se mira la FORMA del error y no `instanceof PrismaClientKnownRequestError`:
  // en el bundle del servidor de Next la clase puede venir de una copia distinta
  // del cliente y el `instanceof` daría false para el mismo error.
  //
  // 23514 es el SQLSTATE de violación de CHECK en PostgreSQL. Prisma lo envuelve
  // como P2039 y deja el texto del driver en el mensaje o en `meta`.
  const meta = (error as { meta?: unknown }).meta;
  const detail = `${error.message} ${safeStringify(meta)}`;
  return detail.includes("23514") || detail.includes("violates check constraint");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // `meta` puede traer referencias cíclicas (el error del driver adentro).
    return "";
  }
}

const CHECK_VIOLATION_MESSAGE =
  "Alguno de los datos cargados no es válido para el sistema. Revisá los montos y la cantidad: reintentar sin corregirlos va a fallar igual.";

const SESSION_EXPIRED_MESSAGE =
  "Tu sesión venció. Abrí el ingreso en otra pestaña, iniciá sesión de nuevo y volvé acá: los datos siguen cargados.";
const FORBIDDEN_MESSAGE =
  "Tu usuario no tiene permiso para registrar pendientes. Pedile a un administrador que lo habilite.";
const IDEMPOTENCY_CONFLICT_MESSAGE =
  "Este intento ya fue usado con datos distintos. Recargá el formulario antes de registrar otro pendiente.";

export async function createPendingAction(
  _prev: PendingFormState,
  formData: FormData,
): Promise<PendingFormState> {
  // Un identificador por INTENTO. Es lo que el operador nos dicta y lo que ata
  // las nueve etapas de este envío entre sí en el log.
  const correlationId = newSupportCode();
  const startedAt = Date.now();
  const submitted = collectSubmittedValues(formData);
  const submitMethod = submitMethodFrom(text(formData, "submitMethod"));
  const idempotencyKey = idempotencyKeyFrom(submitted.idempotencyKey);

  const elapsed = () => Date.now() - startedAt;

  /** Respuesta de fallo: SIEMPRE con el eco de los valores y el código visible. */
  const failure = (
    message: string,
    log: Omit<PendingLogEvent, "correlationId" | "stage">,
  ): PendingFormState => {
    logPendingEvent({
      correlationId,
      stage: PENDING_STAGES.SUBMIT_FAILED,
      submitMethod,
      durationMs: elapsed(),
      response: "error",
      ...log,
    });
    return {
      error: `${message} Código: ${correlationId}`,
      ok: false,
      supportCode: correlationId,
      values: submitted,
      submissionId: correlationId,
    };
  };

  logPendingEvent({
    correlationId,
    stage: PENDING_STAGES.SUBMIT_STARTED,
    submitMethod,
    idempotency: idempotencyKey ? idempotencyKey.slice(0, 8) : null,
    customerPhoneMasked: maskPhone(submitted.customerPhone),
    note: describeText(submitted.note),
    transaction: "not_started",
  });

  // Sesión: se resuelve SIN redirigir. Un `redirect` desde una Server Action
  // aborta la respuesta y se lleva puesto todo lo que la persona escribió.
  const auth = await checkCapability("canCreatePendientes");
  if (!auth.ok) {
    return failure(
      auth.reason === "FORBIDDEN" ? FORBIDDEN_MESSAGE : SESSION_EXPIRED_MESSAGE,
      {
        authState: auth.reason === "FORBIDDEN" ? "forbidden" : "expired",
        outcome: "rejected",
        errorCode: auth.reason,
        transaction: "not_started",
      },
    );
  }
  const session = auth.session;
  const actor = {
    userId: session.user.id,
    userHash: hashEmail(session.user.email),
    role: session.user.role,
  };

  if (idempotencyKey === null) {
    return failure("El intento de registro venció. Recargá el formulario y volvé a enviarlo.", {
      ...actor,
      authState: "valid",
      outcome: "rejected",
      errorCode: "INVALID_IDEMPOTENCY_KEY",
      transaction: "not_started",
    });
  }

  logPendingEvent({
    correlationId,
    stage: PENDING_STAGES.AUTH_VALIDATED,
    ...actor,
    authState: "valid",
    submitMethod,
    durationMs: elapsed(),
    transaction: "not_started",
  });

  const parsed = pendingCreateSchema.safeParse({
    // En modo manual el campo `productId` no existe en el formulario, así que
    // `FormData.get` devuelve null. El schema lo declara opcional (acepta
    // undefined, NO null): sin esta normalización la rama manual nunca validaba.
    productId: formData.get("productId") ?? undefined,
    // Producto manual (opcional): cuando el operador carga uno fuera del catálogo.
    manualName: formData.get("manualName") ?? undefined,
    manualUnit: formData.get("manualUnit") ?? undefined,
    quantity: formData.get("quantity"),
    // FormData devuelve null cuando el campo no viene; lo normalizamos a
    // undefined para que el schema aplique sus reglas (texto opcional / fecha
    // obligatoria) en vez de coercer null a una fecha epoch válida.
    promisedAt: formData.get("promisedAt") ?? undefined,
    customerName: formData.get("customerName") ?? undefined,
    customerPhone: formData.get("customerPhone") ?? undefined,
    customerAddress: formData.get("customerAddress") ?? undefined,
    note: formData.get("note") ?? undefined,
    // Seguimiento del cliente: zona de entrega y estado de pago.
    zone: formData.get("zone") ?? undefined,
    totalAmount: formData.get("totalAmount") ?? undefined,
    paidAmount: formData.get("paidAmount") ?? undefined,
  });

  if (!parsed.success) {
    // Error de validación: los campos vuelven intactos. Corregir un teléfono no
    // puede costar volver a tipear el pedido entero.
    //
    // Y se dice QUÉ corregir. Un "Revisá los datos" genérico obliga a adivinar
    // cuál de trece campos está mal; con el mensaje concreto del validador, el
    // operador arregla ese campo y sigue.
    return failure(firstIssueMessage(parsed.error), {
      ...actor,
      authState: "valid",
      outcome: "rejected",
      errorCode: "VALIDATION",
      transaction: "not_started",
    });
  }

  // Escribió algo en el valor total y el schema lo resolvió como desconocido:
  // solo puede haber sido un cero. Se guarda igual, pero se avisa (ver
  // `savedWithoutTotalAmount`). Un texto ilegible no llega acá — lo rechaza el
  // validador antes, con su propio mensaje.
  const savedWithoutTotalAmount =
    parsed.data.totalAmount === undefined && submitted.totalAmount.trim().length > 0;

  logPendingEvent({
    correlationId,
    stage: PENDING_STAGES.VALIDATION_COMPLETED,
    ...actor,
    submitMethod,
    durationMs: elapsed(),
    transaction: "not_started",
  });

  logPendingEvent({
    correlationId,
    stage: PENDING_STAGES.TRANSACTION_STARTED,
    ...actor,
    submitMethod,
    durationMs: elapsed(),
    transaction: "started",
  });

  let result: Awaited<ReturnType<typeof registerPending>>;
  try {
    result = await registerPending({
      ...parsed.data,
      createdById: session.user.id,
      idempotencyKey,
    });
  } catch (error) {
    // Solo `registerPending` decide si hubo commit: su transacción revierte ante
    // error. Por eso este es el ÚNICO punto que puede informar fallo de alta y
    // habilitar un reintento seguro.
    const { errorClass, errorCode } = describeError(error);
    logPendingError(correlationId, error);
    // Un rechazo de integridad de la base NO invita a reintentar: hay que
    // corregir el dato. Cualquier otro fallo sí puede ser del momento.
    const deterministic = isCheckConstraintViolation(error);
    return failure(
      error instanceof PendingIdempotencyPayloadConflictError
        ? IDEMPOTENCY_CONFLICT_MESSAGE
        : deterministic
        ? CHECK_VIOLATION_MESSAGE
        : "No se pudo registrar el pendiente. Volvé a intentar en unos segundos.",
      {
        ...actor,
        authState: "valid",
        outcome: deterministic ? "rejected" : "exception",
        errorClass,
        errorCode: deterministic ? "CHECK_CONSTRAINT" : errorCode,
        transaction: "rolled_back",
      },
    );
  }

  // Punto de no retorno: a partir de acá el pendiente EXISTE en la base. Es la
  // etapa que separa "no se creó" de "se creó y falló algo después", y es la
  // única razón por la que este log vale la pena.
  logPendingEvent({
    correlationId,
    stage: PENDING_STAGES.TRANSACTION_COMMITTED,
    ...actor,
    submitMethod,
    durationMs: elapsed(),
    transaction: "committed",
    pendingId: result.pending.id,
    // `replay` = este intento no creó nada, su clave ya tenía pendiente. Es la
    // prueba de que la idempotencia frenó un duplicado.
    outcome: "success",
    postCommit: result.replayed ? "replay" : "created",
  });

  // Un replay no tiene efectos nuevos que auditar: el alta ya se auditó cuando
  // ocurrió de verdad. Volver a auditarla inventaría un segundo registro de un
  // hecho que pasó una sola vez.
  if (result.replayed) {
    logPendingEvent({
      correlationId,
      stage: PENDING_STAGES.RESPONSE_SENT,
      ...actor,
      submitMethod,
      durationMs: elapsed(),
      transaction: "committed",
      pendingId: result.pending.id,
      outcome: "success",
      response: "ok",
    });
    return { error: null, ok: true, submissionId: correlationId, savedWithoutTotalAmount };
  }

  logPendingEvent({
    correlationId,
    stage: PENDING_STAGES.POST_COMMIT_STARTED,
    ...actor,
    submitMethod,
    durationMs: elapsed(),
    transaction: "committed",
    pendingId: result.pending.id,
  });

  let postCommit = "ok";

  // Desde acá el pendiente ya existe. Auditoría e invalidación son efectos
  // post-commit: fallar no puede convertir el éxito en error ni sugerir reintento.
  try {
    const context = await auditContextFromHeaders(session.user.id);

    // Producto manual creado al vuelo: lo auditamos como efecto propio para que
    // quede trazado quién metió un producto fuera del catálogo (needsReview).
    if (result.createdProduct) {
      const productAudit = await recordAudit({
        action: AUDIT_ACTIONS.PRODUCT_CREATE,
        module: AUDIT_MODULES.PRODUCTOS,
        entity: "Product",
        entityId: result.createdProduct.id,
        after: {
          code: result.createdProduct.code,
          name: result.createdProduct.name,
          unit: result.createdProduct.unit,
          needsReview: true,
          source: "pendiente-manual",
        },
        context,
        correlationId,
      });
      if (!productAudit.ok) postCommit = "audit_failed";
    }

    const pendingAudit = await recordAudit({
      action: AUDIT_ACTIONS.PENDING_CREATE,
      module: AUDIT_MODULES.PENDIENTES,
      entity: "Pending",
      entityId: result.pending.id,
      // `after` debe ser JSON: el Date de la promesa se guarda como ISO.
      after: {
        productId: result.pending.productId,
        quantity: parsed.data.quantity,
        promisedAt: parsed.data.promisedAt.toISOString(),
        customerName: parsed.data.customerName ?? null,
        // Teléfono: PII del cliente, pero el alta ya audita `customerName`, así
        // que omitirlo acá no protegería nada y sí perdería la traza del dato
        // con el que se comprometió la entrega.
        customerPhone: parsed.data.customerPhone ?? null,
        customerAddress: parsed.data.customerAddress ?? null,
        note: parsed.data.note ?? null,
        manual: parsed.data.manual ?? null,
        // El dinero comprometido con el cliente se audita: quién registró qué
        // abono es exactamente lo que hay que poder reconstruir ante un reclamo.
        zone: parsed.data.zone ?? null,
        totalAmount: parsed.data.totalAmount ?? null,
        paidAmount: parsed.data.paidAmount,
      },
      context,
      correlationId,
    });
    if (!pendingAudit.ok) postCommit = "audit_failed";

    // Si el stock no alcanzó, se generó un faltante automático: lo auditamos
    // como un efecto aparte para que la trazabilidad sea explícita.
    if (result.missingItem) {
      const missingAudit = await recordAudit({
        action: AUDIT_ACTIONS.MISSING_AUTO_CREATE,
        module: AUDIT_MODULES.FALTANTES,
        entity: "MissingItem",
        entityId: result.missingItem.id,
        after: {
          productId: result.missingItem.productId,
          quantity: result.missingItem.quantity,
          originId: result.pending.id,
        },
        context,
        correlationId,
      });
      if (!missingAudit.ok) postCommit = "audit_failed";
    }
  } catch (error) {
    postCommit = "audit_failed";
    logPendingError(correlationId, error);
  }

  // La escritura ya terminó. Un fallo de invalidación no puede dejar la Server
  // Action rechazada ni el formulario bloqueado en "Guardando…"; la próxima
  // navegación vuelve a leer datos frescos de todos modos.
  for (const path of ["/pendientes", "/faltantes"]) {
    try {
      revalidatePath(path);
    } catch (error) {
      postCommit = postCommit === "ok" ? "revalidate_failed" : "audit_and_revalidate_failed";
      logPendingError(correlationId, error);
    }
  }

  logPendingEvent({
    correlationId,
    stage: PENDING_STAGES.POST_COMMIT_COMPLETED,
    ...actor,
    submitMethod,
    durationMs: elapsed(),
    transaction: "committed",
    pendingId: result.pending.id,
    postCommit,
  });

  logPendingEvent({
    correlationId,
    stage: PENDING_STAGES.RESPONSE_SENT,
    ...actor,
    submitMethod,
    durationMs: elapsed(),
    transaction: "committed",
    pendingId: result.pending.id,
    postCommit,
    outcome: "success",
    response: "ok",
  });

  // Éxito: SIN `values`. Esa ausencia es la señal que limpia el formulario, y
  // `submissionId` garantiza que se limpie exactamente una vez.
  return { error: null, ok: true, submissionId: correlationId, savedWithoutTotalAmount };
}

// --------------------------------------------------------------------------
// Ciclo de vida de entrega (Slice A): entregas parciales + cancelación.
// Mismo esqueleto que `orderMissingItemAction`: Zod → requireCapability →
// service → audit best-effort → revalidate. El `customerName` del pendiente
// NUNCA se guarda en el payload de auditoría.
// --------------------------------------------------------------------------

const DELIVERY_REJECTION_MESSAGES: Record<DeliveryRejection, string> = {
  ALREADY_DELIVERED: "Este pendiente ya fue entregado.",
  ALREADY_CANCELLED: "Este pendiente está cancelado.",
  NON_POSITIVE_QUANTITY: "Ingresá una cantidad válida.",
  EXCEEDS_REMAINING: "La cantidad supera lo que resta por entregar.",
  NOT_OWNER: "No podés operar un pendiente creado por otro vendedor.",
  NOT_INVOICED: "Primero debés facturar este pendiente.",
};

const CANCEL_REJECTION_MESSAGES: Record<"ALREADY_DELIVERED" | "ALREADY_CANCELLED" | "NOT_OWNER", string> = {
  ALREADY_DELIVERED: "No se puede cancelar un pendiente ya entregado.",
  ALREADY_CANCELLED: "Este pendiente ya está cancelado.",
  NOT_OWNER: "No podés operar un pendiente creado por otro vendedor.",
};

export async function deliverPendingAction(
  _prev: PendingFormState,
  formData: FormData,
): Promise<PendingFormState> {
  const session = await requireCapability("canDeliverPendings");

  const parsed = pendingDeliverSchema.safeParse({
    id: formData.get("id"),
    quantity: formData.get("quantity"),
  });

  if (!parsed.success) {
    return { error: "Revisá los datos de la entrega.", ok: false };
  }

  try {
    const result = await deliverPending({
      id: parsed.data.id,
      quantity: parsed.data.quantity,
      deliveredById: session.user.id,
      canManageAll: can(session.user.role, "canManageAllPendings"),
    });

		// Un rechazo de negocio no es ruido de formulario: alguien con la capacidad
		// intentó entregar sobre un pendiente que no lo admitía. Queda auditado como
		// FAILURE para que la traza forense exista, con el código de rechazo y la
		// cantidad intentada. Nunca el `customerName`.
		if (result.rejection) {
			await recordAudit({
				action: AUDIT_ACTIONS.PENDING_DELIVERED,
				module: AUDIT_MODULES.PENDIENTES,
				entity: "Pending",
				entityId: parsed.data.id,
				result: "FAILURE",
				after: { reason: result.rejection, attemptedQuantity: parsed.data.quantity },
				context: await auditContextFromHeaders(session.user.id),
			});

			revalidatePath("/pendientes");
			revalidatePath("/dashboard");
			return { error: DELIVERY_REJECTION_MESSAGES[result.rejection], ok: false };
		}

    await recordAudit({
      action: AUDIT_ACTIONS.PENDING_DELIVERED,
      module: AUDIT_MODULES.PENDIENTES,
      entity: "Pending",
      entityId: parsed.data.id,
      after: {
        deliverQuantity: parsed.data.quantity,
        status: result.pending?.status ?? null,
        deliveredQuantity: result.pending?.deliveredQuantity ?? null,
      },
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch (error) {
    logPendingError(null, error);
    return {
      error: "No se pudo registrar la entrega. Intentá de nuevo.",
      ok: false,
    };
  }

  revalidatePath("/pendientes");
  revalidatePath("/dashboard");
  return { error: null, ok: true };
}

// --------------------------------------------------------------------------
// Estado de gestión (Mejora 2): gerencia/compras fija SOLICITADO/BUSQUEDA/
// COTIZANDO/AGOTADO sobre un pendiente abierto. Autoridad de COMPRAS: se gatea
// con `canOrderMissingItems` (solo gerencia), NO con `canCancelPendings` —
// declarar un producto "agotado" es una decisión de compras, no de operación.
// --------------------------------------------------------------------------

const MANAGEMENT_STATUS_REJECTION_MESSAGES: Record<"NOT_ELIGIBLE", string> = {
  NOT_ELIGIBLE:
    "No se pudo actualizar el estado: el pendiente ya no admite cambios de gestión.",
};

export async function updatePendingManagementStatusAction(
  _prev: PendingFormState,
  formData: FormData,
): Promise<PendingFormState> {
  const session = await requireCapability("canOrderMissingItems");

  const parsed = pendingManagementStatusSchema.safeParse({
    id: formData.get("id"),
    status: formData.get("status"),
    expectedStatus: formData.get("expectedStatus") ?? undefined,
  });

  if (!parsed.success) {
    return { error: "No se pudo identificar el pendiente o el estado.", ok: false };
  }

  let result: Awaited<ReturnType<typeof setPendingManagementStatus>>;
  try {
    result = await setPendingManagementStatus({
      id: parsed.data.id,
      status: parsed.data.status,
      expectedStatus: parsed.data.expectedStatus,
    });
  } catch (error) {
    logPendingError(null, error);
    return {
      error: "No se pudo actualizar el estado. Intentá de nuevo.",
      ok: false,
    };
  }

  // Rechazo de negocio: no hubo mutación. La auditoría y revalidación siguen
  // siendo útiles, pero no se confunden con un éxito ya confirmado.
  if (result.rejection) {
    try {
      await recordAudit({
        action: AUDIT_ACTIONS.PENDING_STATUS_CHANGE,
        module: AUDIT_MODULES.PENDIENTES,
        entity: "Pending",
        entityId: parsed.data.id,
        result: "FAILURE",
        after: { reason: result.rejection, status: parsed.data.status },
        context: await auditContextFromHeaders(session.user.id),
      });
    } catch (error) {
      logPendingError(null, error);
    }
    for (const path of ["/pendientes", "/dashboard"]) {
      try {
        revalidatePath(path);
      } catch (error) {
        logPendingError(null, error);
      }
    }
    return {
      error: MANAGEMENT_STATUS_REJECTION_MESSAGES[result.rejection],
      ok: false,
    };
  }

  // Desde acá el cambio ya persistió: fallos de headers/auditoría/revalidación
  // no pueden sugerir un reintento que chocaría con el CAS.
  try {
    await recordAudit({
      action: AUDIT_ACTIONS.PENDING_STATUS_CHANGE,
      module: AUDIT_MODULES.PENDIENTES,
      entity: "Pending",
      entityId: parsed.data.id,
      after: { status: parsed.data.status },
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch (error) {
    logPendingError(null, error);
  }

  // AGOTADO saca al pendiente de los estados alertables: revalidar también el
  // dashboard para que los contadores de vencidos/próximos/urgentes no queden
  // desfasados.
  for (const path of ["/pendientes", "/dashboard"]) {
    try {
      revalidatePath(path);
    } catch (error) {
      logPendingError(null, error);
    }
  }
  return { error: null, ok: true };
}

export async function cancelPendingAction(
  _prev: PendingFormState,
  formData: FormData,
): Promise<PendingFormState> {
  const session = await requireCapability("canCancelPendings");

  const parsed = pendingCancelSchema.safeParse({
    id: formData.get("id"),
    reason: formData.get("reason") ?? undefined,
  });

  if (!parsed.success) {
    return { error: "No se pudo identificar el pendiente.", ok: false };
  }

  try {
    const result = await cancelPendingCommitment({
      id: parsed.data.id,
      cancelledById: session.user.id,
      reason: parsed.data.reason,
      canManageAll: can(session.user.role, "canManageAllPendings"),
    });

		// Mismo criterio que la entrega. El `reason` que tipea el operador es texto
		// libre y puede nombrar al cliente: en un rechazo la cancelación no ocurrió,
		// así que solo se guarda el código de rechazo, no ese texto.
		if (result.rejection) {
			await recordAudit({
				action: AUDIT_ACTIONS.PENDING_CANCELLED,
				module: AUDIT_MODULES.PENDIENTES,
				entity: "Pending",
				entityId: parsed.data.id,
				result: "FAILURE",
				after: { reason: result.rejection },
				context: await auditContextFromHeaders(session.user.id),
			});

			revalidatePath("/pendientes");
			revalidatePath("/dashboard");
			return { error: CANCEL_REJECTION_MESSAGES[result.rejection], ok: false };
		}

    await recordAudit({
      action: AUDIT_ACTIONS.PENDING_CANCELLED,
      module: AUDIT_MODULES.PENDIENTES,
      entity: "Pending",
      entityId: parsed.data.id,
      after: {
        status: result.pending?.status ?? null,
        reason: parsed.data.reason ?? null,
      },
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch (error) {
    logPendingError(null, error);
    return {
      error: "No se pudo cancelar el pendiente. Intentá de nuevo.",
      ok: false,
    };
  }

  revalidatePath("/pendientes");
  revalidatePath("/dashboard");
  return { error: null, ok: true };
}

const CUSTOMER_LIFECYCLE_MESSAGES = {
  NOT_OWNER: "No podés operar un pendiente creado por otro vendedor.",
  NOT_AVAILABLE: "No hay disponibilidad suficiente para esta acción.",
  NOT_CONTACTABLE: "Este pendiente ya no admite registrar contacto.",
  NOT_CONTACTED: "Primero debés registrar el contacto con el cliente.",
  NOT_INVOICED: "Primero debés facturar este pendiente.",
  ALREADY_TERMINAL: "El pendiente ya está cerrado.",
} as const;

// Auditoría y revalidación ocurren DESPUÉS del commit de negocio. Si alguna de
// las dos falla, el hecho ya pasó: devolver un error haría que el vendedor
// reintente una operación que sí quedó registrada, y termine facturando dos
// veces. Se registra el fallo en el log del servidor y la acción reporta éxito,
// que es la verdad.
async function recordPendingLifecycleAudit(
  action: string,
  entityId: string,
  actorId: string,
  after: Prisma.InputJsonValue,
  result: "SUCCESS" | "FAILURE" = "SUCCESS",
): Promise<void> {
  try {
    await recordAudit({
      action,
      module: AUDIT_MODULES.PENDIENTES,
      entity: "Pending",
      entityId,
      result,
      after,
      context: await auditContextFromHeaders(actorId),
    });
  } catch (error) {
    logPendingError(null, error);
  }
}

function revalidatePendingViews(context: string): void {
  for (const path of ["/pendientes", "/dashboard"]) {
    try {
      revalidatePath(path);
    } catch (error) {
      logPendingError(null, error);
    }
  }
}

export async function contactPendingAction(
  _prev: PendingFormState,
  formData: FormData,
): Promise<PendingFormState> {
  const session = await requireCapability("canContactOwnPendings");
  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    return { error: "No se pudo identificar el pendiente.", ok: false };
  }

  let rejection: Awaited<ReturnType<typeof contactPending>>;
  try {
    rejection = await contactPending({
      id,
      actorId: session.user.id,
      canManageAll: can(session.user.role, "canManageAllPendings"),
    });
  } catch (error) {
    logPendingError(null, error);
    return { error: "No se pudo registrar el contacto. Intentá de nuevo.", ok: false };
  }

  if (rejection) {
    // Un rechazo con la capacidad en la mano es intento de operar algo ajeno o
    // ya cerrado: queda como FAILURE para que la traza forense exista.
    await recordPendingLifecycleAudit(
      AUDIT_ACTIONS.PENDING_CONTACTED,
      id,
      session.user.id,
      { reason: rejection },
      "FAILURE",
    );
    return { error: CUSTOMER_LIFECYCLE_MESSAGES[rejection], ok: false };
  }

  await recordPendingLifecycleAudit(
    AUDIT_ACTIONS.PENDING_CONTACTED,
    id,
    session.user.id,
    { customerStatus: "CONTACTADO" },
  );
  revalidatePendingViews("Contacto confirmado");
  return { error: null, ok: true };
}

export async function invoicePendingAction(
  _prev: PendingFormState,
  formData: FormData,
): Promise<PendingFormState> {
  const session = await requireCapability("canInvoiceOwnPendings");
  const id = formData.get("id");
  const quantity = Number(formData.get("quantity"));
  if (typeof id !== "string" || !Number.isInteger(quantity) || quantity <= 0) {
    return { error: "Revisá la cantidad a facturar.", ok: false };
  }

  let rejection: Awaited<ReturnType<typeof invoicePending>>;
  try {
    rejection = await invoicePending({
      id,
      quantity,
      actorId: session.user.id,
      canManageAll: can(session.user.role, "canManageAllPendings"),
    });
  } catch (error) {
    logPendingError(null, error);
    return { error: "No se pudo registrar la factura. Intentá de nuevo.", ok: false };
  }

  if (rejection) {
    await recordPendingLifecycleAudit(
      AUDIT_ACTIONS.PENDING_INVOICED,
      id,
      session.user.id,
      { reason: rejection, attemptedQuantity: quantity },
      "FAILURE",
    );
    return { error: CUSTOMER_LIFECYCLE_MESSAGES[rejection], ok: false };
  }

  await recordPendingLifecycleAudit(
    AUDIT_ACTIONS.PENDING_INVOICED,
    id,
    session.user.id,
    { invoicedQuantity: quantity, customerStatus: "FACTURADO" },
  );
  revalidatePendingViews("Factura confirmada");
  return { error: null, ok: true };
}

const PARTIAL_DECISION_MESSAGES = {
  NOT_OWNER: "No podés operar un pendiente creado por otro vendedor.",
  NOT_PARTIAL: "Este pendiente no tiene una entrega parcial para resolver.",
} as const;

const PARTIAL_DECISIONS = ["espera", "va_con_pedido", "cerrar"] as const;

type PartialDecisionValue = (typeof PARTIAL_DECISIONS)[number];

function parseDecision(value: FormDataEntryValue | null): PartialDecisionValue | null {
  return typeof value === "string" && (PARTIAL_DECISIONS as readonly string[]).includes(value)
    ? (value as PartialDecisionValue)
    : null;
}

/**
 * Registra qué hace el cliente con lo que faltó: lo espera, se lo juntan con
 * otro pedido, o ya no lo quiere y el pendiente se cierra con lo entregado.
 * Sin esto un pendiente parcial quedaba abierto para siempre en la cola.
 */
export async function resolvePartialPendingAction(
  _prev: PendingFormState,
  formData: FormData,
): Promise<PendingFormState> {
  const session = await requireCapability("canDeliverPendings");
  const id = formData.get("id");
  const decision = parseDecision(formData.get("decision"));
  if (typeof id !== "string" || id.length === 0 || decision === null) {
    return { error: "No se pudo identificar la decisión del cliente.", ok: false };
  }

  let rejection: Awaited<ReturnType<typeof resolvePartialPending>>;
  try {
    rejection = await resolvePartialPending({
      id,
      decision,
      actorId: session.user.id,
      canManageAll: can(session.user.role, "canManageAllPendings"),
    });
  } catch (error) {
    logPendingError(null, error);
    return { error: "No se pudo registrar la decisión. Intentá de nuevo.", ok: false };
  }

  if (rejection) {
    await recordPendingLifecycleAudit(
      AUDIT_ACTIONS.PENDING_DELIVERED,
      id,
      session.user.id,
      { reason: rejection, decision },
      "FAILURE",
    );
    return { error: PARTIAL_DECISION_MESSAGES[rejection], ok: false };
  }

  await recordPendingLifecycleAudit(
    AUDIT_ACTIONS.PENDING_DELIVERED,
    id,
    session.user.id,
    { partialDecision: decision },
  );
  revalidatePendingViews("Decisión sobre la entrega parcial");
  return { error: null, ok: true };
}

const UPDATE_REJECTION_MESSAGES = {
  NOT_OWNER: "Solo podés corregir un pendiente que hayas creado vos.",
  ALREADY_EDITED: "Ya corregiste este pendiente. Pedile el cambio a gerencia.",
  ALREADY_CLOSED: "Este pendiente ya está cerrado y no se puede corregir.",
  BELOW_COMMITTED: "La cantidad no puede ser menor a lo ya facturado o entregado.",
} as const;

/**
 * Corrige los datos de un pendiente.
 *
 * Gerencia puede sobre cualquiera y sin límite; el vendedor solo sobre el suyo
 * y una sola vez. La autoridad real la decide el service: acá solo se le pasa
 * si quien pide tiene alcance global.
 *
 * La auditoría guarda el ANTES y el DESPUÉS. Es una corrección de la promesa
 * hecha a un cliente: sin el estado previo no hay forma de reconstruir qué se
 * le había prometido originalmente.
 */
export async function updatePendingAction(
  _prev: PendingFormState,
  formData: FormData,
): Promise<PendingFormState> {
  const session = await requireCapability("canCreatePendientes");

  const parsed = pendingUpdateSchema.safeParse({
    id: formData.get("id"),
    productId: formData.get("productId"),
    quantity: formData.get("quantity"),
    promisedAt: formData.get("promisedAt") ?? undefined,
    customerName: formData.get("customerName") ?? undefined,
    customerPhone: formData.get("customerPhone") ?? undefined,
    customerAddress: formData.get("customerAddress") ?? undefined,
    note: formData.get("note") ?? undefined,
    zone: formData.get("zone") ?? undefined,
    totalAmount: formData.get("totalAmount") ?? undefined,
    paidAmount: formData.get("paidAmount") ?? undefined,
  });

  if (!parsed.success) {
    return { error: "Revisá los datos del pendiente.", ok: false };
  }

  let result: Awaited<ReturnType<typeof updatePending>>;
  try {
    result = await updatePending({
      ...parsed.data,
      actorId: session.user.id,
      canManageAll: can(session.user.role, "canManageAllPendings"),
    });
  } catch (error) {
    logPendingError(null, error);
    return { error: "No se pudo guardar la corrección. Intentá de nuevo.", ok: false };
  }

  if (result.rejection) {
    await recordPendingLifecycleAudit(
      AUDIT_ACTIONS.PENDING_UPDATE,
      parsed.data.id,
      session.user.id,
      { reason: result.rejection },
      "FAILURE",
    );
    return { error: UPDATE_REJECTION_MESSAGES[result.rejection], ok: false };
  }

  const before = result.before;
  await recordPendingLifecycleAudit(
    AUDIT_ACTIONS.PENDING_UPDATE,
    parsed.data.id,
    session.user.id,
    {
      before: before
        ? {
            productId: before.productId,
            quantity: before.quantity,
            promisedAt: before.promisedAt.toISOString(),
            customerName: before.customerName,
            customerPhone: before.customerPhone,
            customerAddress: before.customerAddress,
            zone: before.zone,
            totalAmount: before.totalAmount,
            paidAmount: before.paidAmount,
            note: before.note,
          }
        : null,
      after: {
        productId: parsed.data.productId,
        quantity: parsed.data.quantity,
        promisedAt: parsed.data.promisedAt.toISOString(),
        customerName: parsed.data.customerName,
        customerPhone: parsed.data.customerPhone,
        customerAddress: parsed.data.customerAddress ?? null,
        zone: parsed.data.zone ?? null,
        totalAmount: parsed.data.totalAmount ?? null,
        paidAmount: parsed.data.paidAmount ?? 0,
        note: parsed.data.note ?? null,
      },
    },
  );
  revalidatePendingViews("Corrección del pendiente");
  // La corrección se hace en su propia pantalla, así que terminar significa
  // volver al listado. Quedarse en el formulario en blanco no le decía a nadie
  // si había guardado. `redirect` lanza: nada después de esta línea corre.
  redirect("/pendientes");
}

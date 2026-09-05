"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { checkCapability, requireCapability, type CapabilityDenial } from "@/lib/auth/require-role";
import { can, invoiceScopeFor } from "@/lib/auth/permissions";
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
  resolveWaitlistDecision,
  updatePending,
  deliverPending,
  contactPending,
  invoicePending,
  ManualProductIdentityConflictError,
  PendingIdempotencyPayloadConflictError,
  registerPending,
  setPendingManagementStatus,
} from "@/server/services/pending.service";
import { linkOrionCodeAtCapture, linkOrionCode } from "@/server/services/sku-onboarding.service";
import { findProductById } from "@/server/repositories/product.repository";
import { laboratoryCreateCommandKey } from "@/server/domain/laboratory/identity";
import { findOrCreateLaboratory } from "@/server/repositories/laboratory.repository";
import { SkuConcurrencyError } from "@/server/repositories/sku-review.repository";
import { SkuIdentityError } from "@/server/domain/catalog/sku-identity";
import { SKU_IDENTITY_CONCURRENCY_MESSAGE, messageForIdentityError } from "@/features/productos/sku-identity-messages";
import { orionLinkSchema } from "@/features/productos/schema";
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

function pendingAuthorizationMessage(reason: CapabilityDenial): string {
  if (reason === "NO_SESSION") {
    return "Tu sesión venció. Abrí el ingreso en otra pestaña, iniciá sesión de nuevo y volvé acá.";
  }
  if (reason === "INACTIVE") {
    return "Tu usuario está inactivo. Pedile a un administrador que lo reactive.";
  }
  return "Tu usuario no tiene permiso para realizar esta acción. Pedile a un administrador que lo habilite.";
}

export interface PendingOrionConflictHolder {
  productId: string;
  productName: string;
}

export interface PendingOrionConflict {
  holder: PendingOrionConflictHolder;
}

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
  /** Recuperación accionable cuando el código ya pertenece a otro producto. */
  orionConflict?: PendingOrionConflict | null;
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
  // Identidad Orion: vuelven con el resto. Corregir un conflicto de código no
  // puede costar volver a cargar el pedido entero.
  orionCode: string;
  identitySkippedReason: string;
  identitySkippedNote: string;
  // T3: laboratorio solicitado por el cliente.
  requestedLaboratoryId: string;
  requestedLaboratoryName: string;
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
  "orionCode",
  "identitySkippedReason",
  "identitySkippedNote",
  "requestedLaboratoryId",
  "requestedLaboratoryName",
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
const LINK_FORBIDDEN_MESSAGE =
  "Tu usuario no puede cargar códigos de Orión. Seguí sin el código indicando el motivo, o pedile a un administrador que te habilite.";
// El producto elegido ya tiene OTRO código. Cambiárselo sería una corrección
// de identidad, una decisión explícita y auditada que la captura no toma.
const LINK_REJECTED_MESSAGE =
  "Ese producto ya tiene otro código de Orión cargado. Corregirlo se hace desde la ficha del producto; acá podés seguir sin el código indicando el motivo.";
// Ni código ni aplazamiento. El mensaje nombra las DOS salidas porque decir
// solo "falta el código" a alguien que justamente no lo tiene es un callejón:
// la exigencia siempre viene con su puerta.
const IDENTITY_REQUIRED_MESSAGE =
  "Falta el código de Orión de este producto. Cargalo, o seguí sin él indicando el motivo.";
// Aplazamiento sobre un producto que YA tiene código. No se pide corregir
// nada: el pendiente ya se puede registrar tal cual, solo hay que recargar
// para que la pantalla muestre la identidad que el producto tiene ahora.
const DEFERRAL_NOT_APPLICABLE_MESSAGE =
  "Ese producto ya tiene su código de Orión cargado, así que no hace falta aplazar nada. Recargá la pantalla y volvé a enviar el pendiente.";

/**
 * El código ya es de otro producto.
 *
 * Se NOMBRA al dueño porque eso es lo único que convierte el rechazo en una
 * salida: si el producto correcto era ese, se lo elige y listo; si no, se
 * sigue sin el código. Sin el nombre solo queda adivinar. El código nunca se
 * mueve de un producto a otro por esta vía.
 */
function conflictMessage(holderName: string): string {
  return `Ese código de Orión ya es de "${holderName}". Elegí ese producto, o seguí sin el código indicando el motivo.`;
}

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
    orionConflict?: PendingOrionConflict,
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
      orionConflict,
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
  // Quién escribe identidad, en la forma que espera el servicio de SKU. El
  // `actor` de arriba es el del LOG y lleva el hash del mail; no es lo mismo.
  const actorIdentity = { id: session.user.id, role: session.user.role };

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
    // Identidad Orion (S2b): el schema resuelve el XOR entre el código y el
    // aplazamiento. Qué se hace con el resultado se decide más abajo, contra
    // la base, que es la única que sabe qué identidad tiene hoy el producto.
    orionCode: formData.get("orionCode") ?? undefined,
    identitySkippedReason: formData.get("identitySkippedReason") ?? undefined,
    identitySkippedNote: formData.get("identitySkippedNote") ?? undefined,
    // T3: laboratorio solicitado. OPCIONAL: si el vendedor no lo sabe, el
    // pendiente se guarda sin él.
    //
    // El ID se leía... no se leía. El formulario lo manda desde que existe el
    // autocomplete, el schema lo declara, y este objeto lo omitía: elegir una
    // sugerencia no servía de nada, porque el ID se descartaba y SIEMPRE se
    // resolvía por nombre. Funcionaba de casualidad —resolver "Genfar" devuelve
    // Genfar— pero gastaba una consulta de más y, peor, pasaba por
    // `findOrCreateLaboratory`: si el nombre normalizaba distinto del guardado,
    // creaba un laboratorio nuevo en vez de usar el que la persona eligió.
    requestedLaboratoryId: formData.get("requestedLaboratoryId") ?? undefined,
    requestedLaboratoryName: formData.get("requestedLaboratoryName") ?? undefined,
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

  // ------------------------------------------------------------------------
  // Identidad Orion (S2b).
  //
  // Un CÓDIGO escribe la identidad de un producto, así que exige autoridad
  // propia. Un APLAZAMIENTO no toca ningún producto —solo deja constancia en
  // este pendiente— y por eso no la exige: pedirla sería negarle la salida a
  // quien justamente no pudo conseguir el código.
  // ------------------------------------------------------------------------
  const { identity, ...capture } = parsed.data;

  // La autoridad se relee de la base, así que su motivo puede diferir del de
  // la primera lectura: entre las dos, a alguien pueden haberlo desactivado.
  // Confundir "se te venció la sesión" con "no tenés permiso" lo manda a
  // perseguir un permiso que ya tiene.
  let linkActor = actorIdentity;
  if (identity?.kind === "CODE") {
    const linkAuth = await checkCapability("canLinkProductIdentity");
    if (!linkAuth.ok) {
      const expired = linkAuth.reason !== "FORBIDDEN";
      return failure(expired ? SESSION_EXPIRED_MESSAGE : LINK_FORBIDDEN_MESSAGE, {
        ...actor,
        authState: expired ? "expired" : "forbidden",
        outcome: "rejected",
        errorCode: expired ? linkAuth.reason : "FORBIDDEN_LINK",
        transaction: "not_started",
      });
    }
    // La autoridad se validó contra ESTA lectura, así que es esta la que viaja
    // al servicio: mandar la otra dejaría el permiso comprobado sobre un rol y
    // la escritura hecha con otro.
    linkActor = { id: linkAuth.session.user.id, role: linkAuth.session.user.role };
  }

  // El producto del catálogo se relee acá, UNA vez, antes de decidir nada:
  // la identidad que decide es la que tiene HOY en la base, no la que la
  // pantalla creyó ver al pintarse. Entre las dos, otro pudo haberle
  // vinculado el código —o haberlo borrado del catálogo.
  const product = capture.productId ? await findProductById(capture.productId) : null;
  if (capture.productId && !product) {
    return failure("El producto elegido ya no está disponible. Recargá la pantalla.", {
      ...actor,
      authState: "valid",
      outcome: "rejected",
      errorCode: "UNKNOWN_PRODUCT",
      transaction: "not_started",
    });
  }

  // ------------------------------------------------------------------------
  // La exigencia (S2b · 1e-D).
  //
  // Sin código y sin aplazamiento, el pendiente NO entra. La única excepción
  // es el producto que ya tiene el suyo: a ese no se le pregunta de nuevo ni
  // se le vincula nada, porque ya está identificado.
  //
  // Esta comprobación NO confía en la pantalla. El formulario ya marca el
  // campo como obligatorio, pero un `required` de HTML lo saltea cualquiera
  // que arme el FormData a mano, y un envío viejo puede llegar con una
  // identidad que dejó de ser cierta. Por eso se decide contra la base.
  //
  // El producto MANUAL cae acá por construcción: todavía no existe, así que
  // no tiene código, y su alta tiene que traer una de las dos salidas.
  // ------------------------------------------------------------------------
  if (identity === undefined && !product?.orionCode) {
    return failure(IDENTITY_REQUIRED_MESSAGE, {
      ...actor,
      authState: "valid",
      outcome: "rejected",
      errorCode: "IDENTITY_REQUIRED",
      transaction: "not_started",
    });
  }

  // ------------------------------------------------------------------------
  // Y el otro lado de la misma regla: sobre un producto YA identificado, un
  // aplazamiento no es una salida sino una contradicción.
  //
  // El aplazamiento significa "no pude conseguir el código". Guardarlo contra
  // un producto que lo tiene deja en el historial —de forma permanente, por
  // D9— un motivo que contradice la realidad de la fila de al lado. Y nadie
  // puede corregirlo después: el aviso se apaga solo por estado derivado,
  // pero el motivo queda escrito para siempre.
  //
  // La pantalla no ofrece este control cuando el producto tiene código, así
  // que esto llega de un FormData armado a mano, o de un envío que quedó
  // atrás: entre que se pintó el formulario y llegó este envío, otro pudo
  // haber vinculado ese código. Por eso se decide contra la base y no contra
  // lo que la pantalla creyó ver.
  // ------------------------------------------------------------------------
  if (identity?.kind === "DEFERRED" && product?.orionCode) {
    return failure(DEFERRAL_NOT_APPLICABLE_MESSAGE, {
      ...actor,
      authState: "valid",
      outcome: "rejected",
      errorCode: "DEFERRAL_NOT_APPLICABLE",
      transaction: "not_started",
    });
  }

  // Producto del CATÁLOGO con código: se vincula ANTES de registrar y en su
  // propia transacción. Meterlo en la del pendiente le agregaría un lock de
  // producto a la transacción que ya toma locks de lotes, y ese orden nuevo es
  // exactamente cómo se fabrica un deadlock (ver el orden global de locks).
  if (identity?.kind === "CODE" && product) {
    // `linkOrionCodeAtCapture` DEVUELVE el conflicto de dueño, pero TIRA en
    // los otros dos rechazos: perder el compare-and-set, y el producto que ya
    // tiene OTRO código —mover ese código sería RELINK, que la captura no
    // puede hacer—. Una excepción que escapa de una Server Action se lleva
    // puesto el eco de los valores: es el incidente de julio/agosto de 2026,
    // el mismo que estas pantallas existen para no repetir.
    let linked: Awaited<ReturnType<typeof linkOrionCodeAtCapture>>;
    try {
      linked = await linkOrionCodeAtCapture({
        actor: linkActor,
        identity: { productId: product.id },
        orionCode: identity.orionCode,
        // La versión que se acaba de leer es el compare-and-set: quien escribe
        // declara la versión que observó y PIERDE si otro llegó antes.
        expectedVersion: product.identityVersion,
      });
    } catch (error) {
      logPendingError(correlationId, error);
      const { errorClass, errorCode } = describeError(error);
      // Perder la carrera NO invita a reintentar a ciegas: reintentar sin
      // mirar qué identidad quedó puesta vuelve a perder, o peor, pisa la
      // decisión de otro. Hay que refrescar y mirar.
      const lost = error instanceof SkuConcurrencyError;
      if (!lost && !(error instanceof SkuIdentityError)) throw error;
      return failure(lost ? SKU_IDENTITY_CONCURRENCY_MESSAGE : LINK_REJECTED_MESSAGE, {
        ...actor,
        authState: "valid",
        outcome: "rejected",
        errorClass,
        errorCode,
        transaction: "not_started",
      });
    }

    if (linked.status === "ORION_CONFLICT") {
      return failure(
        conflictMessage(linked.holder.name),
        {
          ...actor,
          authState: "valid",
          outcome: "rejected",
          errorCode: "ORION_CONFLICT",
          transaction: "not_started",
        },
        {
          holder: {
            productId: linked.holder.id,
            productName: linked.holder.name,
          },
        },
      );
    }

    // Punto de no retorno de la identidad: si el vínculo se escribió, quedó
    // escrito aunque el pendiente falle después. Sin esta línea, ese efecto
    // durable no aparece en ningún lado del log.
    if (linked.status === "LINKED") {
      logPendingEvent({
        correlationId,
        stage: PENDING_STAGES.IDENTITY_LINKED,
        ...actor,
        submitMethod,
        durationMs: elapsed(),
        transaction: "committed",
      });
    }
  }

  logPendingEvent({
    correlationId,
    stage: PENDING_STAGES.TRANSACTION_STARTED,
    ...actor,
    submitMethod,
    durationMs: elapsed(),
    transaction: "started",
  });

  // ──────────────────────────────────────────────────────────────────────
  // T3: Resolución de laboratorio.
  //
  // El usuario escribe un nombre y envía. Si no clickeó "Crear", el ID
  // viene vacío pero el nombre viene en `requestedLaboratoryName`.
  // Acá lo resolvemos: buscamos por nombre, creamos si no existe.
  // Así el vendedor solo escribe y listo — sin pasos extra.
  // ──────────────────────────────────────────────────────────────────────
  let resolvedLabId = capture.requestedLaboratoryId;
  if (!resolvedLabId && capture.requestedLaboratoryName) {
    try {
      const lab = await findOrCreateLaboratory({
        name: capture.requestedLaboratoryName,
        commandKey: laboratoryCreateCommandKey(
          "auto",
          session.user.id,
          capture.requestedLaboratoryName,
        ),
      });
      resolvedLabId = lab.laboratory.id;
    } catch (error) {
      logPendingError(correlationId, error);
      return failure("No se pudo resolver el laboratorio. Reintentá.", {
        ...actor,
        authState: "valid",
        outcome: "rejected",
        errorCode: "LABORATORY_RESOLVE_FAILED",
        transaction: "not_started",
      });
    }
  }

  let result: Awaited<ReturnType<typeof registerPending>>;
  try {
    result = await registerPending({
      ...capture,
      requestedLaboratoryId: resolvedLabId,
      // El producto MANUAL recibe el código en su alta, no por una vinculación
      // aparte: nace con su identidad y nunca existe sin ella.
      manual:
        capture.manual && identity?.kind === "CODE"
          ? { ...capture.manual, orionCode: identity.orionCode }
          : capture.manual,
      identitySkippedReason: identity?.kind === "DEFERRED" ? identity.reason : undefined,
      identitySkippedNote: identity?.kind === "DEFERRED" ? identity.note : undefined,
      createdById: session.user.id,
      idempotencyKey,
    });
  } catch (error) {
    if (error instanceof ManualProductIdentityConflictError) {
      logPendingError(correlationId, error);
      return failure(
        conflictMessage(error.holder.name),
        {
          ...actor,
          authState: "valid",
          outcome: "rejected",
          errorCode: "ORION_CONFLICT",
          transaction: "rolled_back",
        },
        {
          holder: {
            productId: error.holder.id,
            productName: error.holder.name,
          },
        },
      );
    }
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
  // Accionable: dice qué falta y a dónde ir. Un "no se pudo" genérico deja al
  // vendedor reintentando sobre algo que no va a cambiar solo.
  NO_INVENTORY:
    "No hay mercadería reservada para este pendiente. Bodega tiene que registrar la entrada antes de poder entregar.",
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

// Facturar tiene sus propios rechazos porque tiene sus propias reglas: dos de
// ellos —"no tenés autoridad" y "no llegó la mercadería"— no existen en el
// resto del ciclo. Mandarlos por el mapa genérico obligaba a decir "no hay
// disponibilidad suficiente" cuando el problema era el permiso, y a decir
// "revisá la cantidad" cuando la cantidad estaba perfecta y lo que faltaba era
// stock. Un mensaje que no nombra la causa real hace que la persona reintente
// exactamente lo mismo.
const INVOICE_REJECTION_MESSAGES = {
  NOT_AUTHORIZED: "Tu perfil no puede facturar pendientes.",
  NOT_OWNER: "No podés facturar un pendiente creado por otro vendedor.",
  ALREADY_TERMINAL: "El pendiente ya está cerrado.",
  INVALID_QUANTITY: "Revisá la cantidad a facturar.",
  NO_STOCK: "Todavía no hay mercadería cargada para facturar.",
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
  const session = await requireCapability("canContactPendings");
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
  const session = await requireCapability("canInvoicePendings");
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
      // El alcance se deriva de la matriz de permisos, no de una comparación de
      // roles suelta acá. El actor que queda auditado es SIEMPRE el de la
      // sesión: quien factura el pendiente de otro se registra a sí mismo.
      scope: invoiceScopeFor(session.user.role),
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
    return { error: INVOICE_REJECTION_MESSAGES[rejection], ok: false };
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

const WAIT_DECISION_MESSAGES = {
  NOT_OWNER: "No podés operar un pendiente creado por otro vendedor.",
  NOT_PARTIAL: "Este pendiente no tiene una entrega parcial para resolver.",
} as const;

const WAITLIST_DECISIONS = ["espera", "va_con_pedido", "cerrar"] as const;

type WaitlistDecisionValue = (typeof WAITLIST_DECISIONS)[number];

function parseDecision(value: FormDataEntryValue | null): WaitlistDecisionValue | null {
  return typeof value === "string" && (WAITLIST_DECISIONS as readonly string[]).includes(value)
    ? (value as WaitlistDecisionValue)
    : null;
}

/**
 * Registra qué hace el cliente con lo que faltó: lo espera, se lo juntan con
 * otro pedido, o ya no lo quiere y el pendiente se cierra con lo entregado.
 * Sin esto un pendiente parcial quedaba abierto para siempre en la cola.
 */
export async function resolveWaitlistDecisionAction(
  _prev: PendingFormState,
  formData: FormData,
): Promise<PendingFormState> {
  const session = await requireCapability("canDeliverPendings");
  const id = formData.get("id");
  const decision = parseDecision(formData.get("decision"));
  if (typeof id !== "string" || id.length === 0 || decision === null) {
    return { error: "No se pudo identificar la decisión del cliente.", ok: false };
  }

  let rejection: Awaited<ReturnType<typeof resolveWaitlistDecision>>;
  try {
    rejection = await resolveWaitlistDecision({
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
    return { error: WAIT_DECISION_MESSAGES[rejection], ok: false };
  }

  await recordPendingLifecycleAudit(
    AUDIT_ACTIONS.PENDING_DELIVERED,
    id,
    session.user.id,
    { waitlistDecision: decision },
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

// --------------------------------------------------------------------------
// Resolver un producto de la cola de identidad pendiente (S2b · 2-B2).
//
// Vincula el código de Orión de un producto que quedó sin identidad porque
// alguien usó la salida con motivo al capturar. Es la misma operación que el
// vínculo del catálogo, pero con otra autoridad: `canFixProductIdentity` en
// vez de `canManageProducts`. SUPERVISOR entra; OPERADOR no.
//
// Revalida tanto la página del producto como la cola, porque el producto sale
// de la cola al recibir su código.
// --------------------------------------------------------------------------
export type ResolvePendingIdentityState = { error: string | null; ok: boolean };

export async function resolvePendingIdentityAction(
  _prev: ResolvePendingIdentityState,
  formData: FormData,
): Promise<ResolvePendingIdentityState> {
  const authorization = await checkCapability("canFixProductIdentity");
  if (!authorization.ok) {
    return { error: pendingAuthorizationMessage(authorization.reason), ok: false };
  }
  const session = authorization.session;

  const parsed = orionLinkSchema.safeParse({
    expectedVersion: formData.get("expectedVersion"),
    orionCode: formData.get("orionCode"),
    productId: formData.get("productId"),
  });

  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Revisá los datos del vínculo.",
      ok: false,
    };
  }

  try {
    await linkOrionCode({
      actor: { id: session.user.id, role: session.user.role },
      context: await auditContextFromHeaders(session.user.id),
      expectedVersion: parsed.data.expectedVersion,
      identity: { productId: parsed.data.productId },
      intent: "LINK",
      orionCode: parsed.data.orionCode,
    });
  } catch (error) {
    if (error instanceof SkuConcurrencyError) {
      return { error: SKU_IDENTITY_CONCURRENCY_MESSAGE, ok: false };
    }
    if (error instanceof SkuIdentityError) {
      return { error: messageForIdentityError(error.code), ok: false };
    }
    return { error: messageForIdentityError(undefined), ok: false };
  }

  try {
    revalidatePath(`/productos/${parsed.data.productId}`);
    revalidatePath("/productos");
    revalidatePath("/revision-identidad-pendientes");
  } catch (error) {
    console.error(`[pendientes] resolveIdentity escrita, pero falló el refresco:`, error);
  }

  return { error: null, ok: true };
}

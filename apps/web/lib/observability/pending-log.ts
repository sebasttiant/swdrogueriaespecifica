// --------------------------------------------------------------------------
// Log estructurado del alta de pendientes. NODE-ONLY (Server Actions).
// NUNCA importar desde un componente cliente ni desde middleware (Edge): estos
// eventos van al log del servidor y no deben viajar al navegador.
//
// Existe por un incidente concreto: el operador reportaba "no guarda" y el
// servidor no tenía forma de decir en qué etapa se había caído ese intento en
// particular. Los `console.error` sueltos que había decían QUÉ falló, no A QUIÉN
// ni CUÁNDO ni si la transacción había confirmado.
//
// Cada evento sale como UNA línea de JSON con un prefijo fijo, para que se pueda
// leer con `grep` pelado en el VPS —sin jq, sin agregador, sin instalar nada— y
// también parsear después si hace falta.
//
// La etapa `pending.transaction.committed` es la que importa de verdad: separa
// "no se creó" de "se creó y falló algo después". Confundir esas dos cosas es lo
// que hace que alguien reintente un registro que ya existía.
//
// PRIVACIDAD: acá no entra ningún dato del cliente. Ver `redaction.ts` — los
// identificadores son internos, hasheados o enmascarados. Nunca el nombre, la
// dirección, la nota, el teléfono completo ni el FormData.
// --------------------------------------------------------------------------

export const PENDING_STAGES = {
  SUBMIT_STARTED: "pending.submit.started",
  AUTH_VALIDATED: "pending.auth.validated",
  VALIDATION_COMPLETED: "pending.validation.completed",
  TRANSACTION_STARTED: "pending.transaction.started",
  TRANSACTION_COMMITTED: "pending.transaction.committed",
  POST_COMMIT_STARTED: "pending.post_commit.started",
  POST_COMMIT_COMPLETED: "pending.post_commit.completed",
  RESPONSE_SENT: "pending.response.sent",
  SUBMIT_FAILED: "pending.submit.failed",
} as const;

export type PendingStage = (typeof PENDING_STAGES)[keyof typeof PENDING_STAGES];

/** Prefijo de línea. Es el ancla del `grep` documentado en el runbook. */
export const PENDING_LOG_PREFIX = "[pendientes.diag]";

/**
 * Estado de la transacción de negocio en el momento del evento.
 *
 * `committed` es una AFIRMACIÓN sobre la base: el pendiente existe. No se emite
 * por optimismo, solo después de que `registerPending` devolvió.
 */
export type TransactionState = "not_started" | "started" | "committed" | "rolled_back";

/** Cómo terminó el intento, desde el punto de vista del operador. */
export type SubmitOutcome = "success" | "rejected" | "exception";

/** Cómo se disparó el envío. `unknown` cuando el navegador no lo reportó. */
export type SubmitMethod = "enter" | "click" | "unknown";

export type PendingLogEvent = {
  correlationId: string;
  stage: PendingStage;
  /** Id interno del usuario. No es PII: no sirve fuera de esta base. */
  userId?: string | null;
  /** Identidad estable del correo, sin el correo. Ver `hashEmail`. */
  userHash?: string | null;
  role?: string | null;
  submitMethod?: SubmitMethod;
  /** `valid` | `expired` | `forbidden`. Nunca el token ni la cookie. */
  authState?: string;
  durationMs?: number;
  outcome?: SubmitOutcome;
  /** Código estable del error (ej. `P2002`, `POOL_TIMEOUT`). Nunca el mensaje crudo. */
  errorCode?: string | null;
  /** Clase del error (ej. `PrismaClientKnownRequestError`). Nunca el stack. */
  errorClass?: string | null;
  transaction?: TransactionState;
  /** Id del pendiente creado, cuando existe. La prueba de que se creó. */
  pendingId?: string | null;
  /** Resultado de auditoría/revalidación: `ok`, `audit_failed`, `revalidate_failed`. */
  postCommit?: string | null;
  /** Lo que se le devolvió al cliente: `ok` | `error`. Nunca el payload. */
  response?: string | null;
  /** Clave de idempotencia enmascarada: prefijo, para correlacionar reintentos. */
  idempotency?: string | null;
  /** Teléfono enmascarado (`***5273`), solo para confirmar de qué intento hablamos. */
  customerPhoneMasked?: string | null;
  /** Presencia/longitud de la nota. Nunca su contenido. */
  note?: string | null;
};

/**
 * Nivel de detalle, para poder bajarlo cuando el diagnóstico termine sin tener
 * que redeployar código:
 *
 *   full   (default) — las nueve etapas. Es lo que se quiere durante un incidente.
 *   errors           — solo fallos y respuestas no exitosas.
 *   off              — nada.
 *
 * Se lee en cada llamada y no una sola vez al importar: así un cambio de la
 * variable aplica al reiniciar el contenedor, sin depender del orden de carga
 * de los módulos.
 */
function level(): "full" | "errors" | "off" {
  const raw = (process.env.PENDING_DIAGNOSTICS ?? "full").trim().toLowerCase();
  return raw === "off" || raw === "errors" ? raw : "full";
}

function isFailureEvent(event: PendingLogEvent): boolean {
  return (
    event.stage === PENDING_STAGES.SUBMIT_FAILED ||
    (event.outcome !== undefined && event.outcome !== "success")
  );
}

/** La versión desplegada, para saber si un intento corrió con el fix o sin él. */
function appVersion(): string {
  return process.env.APP_COMMIT ?? "unknown";
}

/**
 * Emite un evento. NO lanza nunca: un fallo al loguear no puede tumbar el
 * registro de un pendiente — sería exactamente el tipo de bug que este módulo
 * existe para diagnosticar.
 */
export function logPendingEvent(event: PendingLogEvent): void {
  try {
    const mode = level();
    if (mode === "off") return;
    if (mode === "errors" && !isFailureEvent(event)) return;

    const line = {
      ts: new Date().toISOString(),
      ...event,
      appVersion: appVersion(),
    };
    // `console.log` y no `console.error`: son eventos de traza, no fallos del
    // proceso. El fallo se distingue por `stage`/`outcome`, no por el stream.
    console.log(`${PENDING_LOG_PREFIX} ${JSON.stringify(line)}`);
  } catch {
    // Silencio deliberado: ver el contrato de arriba.
  }
}

/**
 * Traduce un error desconocido a un par (clase, código) apto para log.
 *
 * NUNCA devuelve el mensaje del error: los mensajes de Prisma pueden incluir
 * valores de las columnas en conflicto, y ahí es donde se filtraría el teléfono
 * o el nombre del cliente sin que nadie lo note.
 */
export function describeError(error: unknown): {
  errorClass: string;
  errorCode: string | null;
} {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      errorClass: error.name || error.constructor.name,
      errorCode: typeof code === "string" ? code : null,
    };
  }
  return { errorClass: typeof error, errorCode: null };
}

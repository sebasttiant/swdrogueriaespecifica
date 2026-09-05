"use server";

import { revalidatePath } from "next/cache";

import {
  linkMissingReportSchema,
  missingReportSubmitSchema,
  resolveMissingReportsSchema,
} from "@/features/faltantes/schema";
import { REVIEW_QUEUE_PATH } from "@/features/faltantes/report-queue-paging";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { requireCapability } from "@/lib/auth/require-role";
import { findOrCreateLaboratory } from "@/server/repositories/laboratory.repository";
import { laboratoryCreateCommandKey } from "@/server/domain/laboratory/identity";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import {
  linkReportToProduct,
  markReportsArrivedAtWarehouse,
  orderReports,
  resolveReports,
  MissingReportEmptyNameError,
  MissingReportLinkError,
  MissingReportResolveConflictError,
  submitMissingReport,
} from "@/server/services/missing-report.service";

export type MissingReportActionState = { error: string | null; ok: boolean };

// Mensaje único de validación del nombre: lo comparten el schema (vacío/largo)
// y el rechazo de dominio (normaliza a vacío), para no filtrar al vendedor la
// diferencia entre "escribiste espacios" y "escribiste solo símbolos".
const INVALID_NAME_MESSAGE = "Escribí el nombre del producto.";

export async function createMissingReportAction(
  _prev: MissingReportActionState,
  formData: FormData,
): Promise<MissingReportActionState> {
  const session = await requireCapability("canSubmitMissingReports");

  const parsed = missingReportSubmitSchema.safeParse({
    rawName: formData.get("rawName"),
    sellerCode: formData.get("sellerCode") ?? undefined,
    presentation: formData.get("presentation") ?? undefined,
    requestedLaboratoryId: formData.get("requestedLaboratoryId") ?? undefined,
    requestedLaboratoryName: formData.get("requestedLaboratoryName") ?? undefined,
  });
  if (!parsed.success) {
    // Surface the schema's specific message (empty vs too long), como
    // `orderMissingItemAction`, con un fallback estable.
    const message = parsed.error.issues[0]?.message ?? INVALID_NAME_MESSAGE;
    return { error: message, ok: false };
  }

  // Laboratorio: el selector manda el ID si el vendedor eligió uno de la lista.
  // Si escribió un nombre y envió sin clickear "Crear", llega solo el nombre y
  // se resuelve acá. Mismo camino que el formulario de pendientes, con el mismo
  // componente: dos pantallas que piden el mismo dato no pueden pedirlo de dos
  // maneras distintas.
  //
  // El laboratorio es OPCIONAL, así que un fallo al resolverlo NO puede tumbar
  // el reporte: el faltante es lo que importa, y perderlo por un dato accesorio
  // sería cambiar algo que sirve por algo que adorna. Se sigue sin laboratorio.
  let resolvedLaboratoryId = parsed.data.requestedLaboratoryId;
  if (!resolvedLaboratoryId && parsed.data.requestedLaboratoryName) {
    try {
      const lab = await findOrCreateLaboratory({
        name: parsed.data.requestedLaboratoryName,
        commandKey: laboratoryCreateCommandKey(
          "auto",
          session.user.id,
          parsed.data.requestedLaboratoryName,
        ),
      });
      resolvedLaboratoryId = lab.laboratory.id;
    } catch (error) {
      console.error("[faltantes] No se pudo resolver el laboratorio:", error);
    }
  }

  // El reporterId SIEMPRE sale de la sesión: cualquier `reporterId` que venga
  // en el FormData se ignora por construcción (no se lee).
  let report: Awaited<ReturnType<typeof submitMissingReport>>;
  try {
    report = await submitMissingReport({
      rawName: parsed.data.rawName,
      sellerCode: parsed.data.sellerCode,
      reporterId: session.user.id,
      presentation: parsed.data.presentation,
      requestedLaboratoryId: resolvedLaboratoryId,
    });
  } catch (error) {
    // Nombre que normaliza a vacío (solo control chars): error de validación,
    // no de infraestructura. No se persistió nada.
    if (error instanceof MissingReportEmptyNameError) {
      return { error: INVALID_NAME_MESSAGE, ok: false };
    }
    console.error("[faltantes] No se pudo enviar el reporte:", error);
    return { error: "No se pudo enviar el reporte. Intentá de nuevo.", ok: false };
  }

  // El reporte ya existe. La auditoría es best-effort: si falla, se registra el
  // error pero el reporte sigue siendo un éxito para el vendedor. El try/catch
  // no es redundante con `recordAudit` (que ya no relanza): protege también
  // `auditContextFromHeaders`, que lee headers() y sí puede lanzar. La metadata
  // es mínima y segura: nunca el nombre crudo, solo su longitud.
  try {
    await recordAudit({
      action: AUDIT_ACTIONS.MISSING_REPORT_CREATE,
      module: AUDIT_MODULES.FALTANTES,
      entity: "MissingReport",
      entityId: report.id,
      after: { status: "PENDING_REVIEW", nameLength: parsed.data.rawName.length },
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch (error) {
    console.error("[faltantes] El reporte se creó, pero no se pudo auditar:", error);
  }

  try {
    revalidatePath("/faltantes");
  } catch (error) {
    console.error("[faltantes] El reporte se creó, pero no se pudo revalidar:", error);
  }

  return { error: null, ok: true };
}

export type LinkMissingReportActionState = {
  error: string | null;
  ok: boolean;
  missingItemId?: string;
};

// Rechazos de negocio de la vinculación → mensaje para gerencia.
const LINK_REJECTION_MESSAGES: Record<MissingReportLinkError["reason"], string> = {
  PRODUCT_NOT_FOUND: "El producto no existe o está inactivo.",
  ALREADY_LINKED: "Estos reportes ya fueron revisados. Actualizá la cola.",
};

/**
 * Convierte un grupo de reportes de vendedores en un faltante canónico,
 * apuntando al producto que gerencia eligió del catálogo.
 *
 * Solo gerencia (`canReviewMissingReports`). El usuario que vincula sale SIEMPRE
 * de la sesión: un `userId` en el FormData se ignora por construcción.
 */
export async function linkMissingReportToProductAction(
  _prev: LinkMissingReportActionState,
  formData: FormData,
): Promise<LinkMissingReportActionState> {
  const session = await requireCapability("canReviewMissingReports");

  const parsed = linkMissingReportSchema.safeParse({
    normalizedName: formData.get("normalizedName"),
    productId: formData.get("productId"),
  });
  if (!parsed.success) {
    const message =
      parsed.error.issues[0]?.message ?? "Revisá los datos de la vinculación.";
    return { error: message, ok: false };
  }

  let result: Awaited<ReturnType<typeof linkReportToProduct>>;
  try {
    result = await linkReportToProduct({
      normalizedName: parsed.data.normalizedName,
      productId: parsed.data.productId,
      userId: session.user.id,
    });
  } catch (error) {
    if (error instanceof MissingReportLinkError) {
      return { error: LINK_REJECTION_MESSAGES[error.reason], ok: false };
    }
    console.error("[faltantes] No se pudo vincular el reporte:", error);
    return { error: "No se pudo vincular el reporte. Intentá de nuevo.", ok: false };
  }

  // El vínculo YA existe. Auditoría best-effort: si falla, se registra el error
  // pero para gerencia sigue siendo un éxito — reintentar chocaría con un grupo
  // ya vinculado. Metadata mínima: nunca nombres de reportantes ni el texto
  // crudo, solo cuántos reportes se vincularon.
  try {
    await recordAudit({
      action: AUDIT_ACTIONS.MISSING_REPORT_LINKED,
      module: AUDIT_MODULES.FALTANTES,
      entity: "MissingReport",
      entityId: result.missingItem.id,
      after: {
        productId: parsed.data.productId,
        missingItemId: result.missingItem.id,
        linkedReportsCount: result.linkedReportsCount,
      },
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch (error) {
    console.error("[faltantes] El reporte se vinculó, pero no se pudo auditar:", error);
  }

  // La cola pierde el grupo y la lista de faltantes gana el nuevo registro.
  for (const path of ["/revision-faltantes", "/faltantes"]) {
    try {
      revalidatePath(path);
    } catch (error) {
      console.error("[faltantes] El reporte se vinculó, pero no se pudo revalidar:", error);
    }
  }

  return { error: null, ok: true, missingItemId: result.missingItem.id };
}

export type ResolveReportsActionState = { error: string | null; ok: boolean };

// Cada resolución tiene su propia entrada de auditoría: "lo pedí", "no se pide"
// y "llegó" son hechos distintos, y meterlos bajo una sola acción haría
// imposible reconstruir qué pasó.
const REPORT_RESOLUTION_AUDIT = {
  ORDERED: AUDIT_ACTIONS.MISSING_REPORT_ORDERED,
  DISCARDED: AUDIT_ACTIONS.MISSING_REPORT_DISCARDED,
  EN_BODEGA: AUDIT_ACTIONS.MISSING_REPORT_RECEIVED,
} as const;

/**
 * Saca un grupo de reportes de la cola de revisión, sin pasar por el catálogo.
 *
 * Regla del gerente (reunión 2026-07-30): "yo marco los chulitos y ya". Lee el
 * nombre que pegó el vendedor, sabe qué producto es y lo pide por teléfono.
 * Antes la única salida era vincular al catálogo, así que un producto que no
 * estaba cargado dejaba el reporte atrapado y la cola solo crecía.
 *
 * Dos resoluciones con significados OPUESTOS, nunca un "OK" ambiguo:
 *   ORDERED   → gerencia ya lo compró.
 *   DISCARDED → nadie lo va a pedir.
 *
 * Gateada con `canReviewMissingReports`, igual que vincular: decidir qué pasa
 * con lo que reportó un vendedor es una decisión de gerencia.
 */
export async function resolveMissingReportsAction(
  _prev: ResolveReportsActionState,
  formData: FormData,
): Promise<ResolveReportsActionState> {
  const session = await requireCapability("canReviewMissingReports");

  const parsed = resolveMissingReportsSchema.safeParse({
    normalizedName: formData.get("normalizedName"),
    resolution: formData.get("resolution"),
    expectedStatus: formData.get("expectedStatus") ?? undefined,
  });

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Revisá la selección.";
    return { error: message, ok: false };
  }

  let result: Awaited<ReturnType<typeof resolveReports>>;
  try {
    // El responsable sale SIEMPRE de la sesión: un `userId` inyectado en el
    // FormData no se lee.
    if (parsed.data.resolution === "ORDERED") {
      result = await orderReports({ normalizedName: parsed.data.normalizedName, userId: session.user.id });
    } else if (parsed.data.resolution === "EN_BODEGA") {
      result = await markReportsArrivedAtWarehouse({ normalizedName: parsed.data.normalizedName, userId: session.user.id });
    } else {
      result = await resolveReports({
        normalizedName: parsed.data.normalizedName,
        resolution: parsed.data.resolution,
        expectedStatus: parsed.data.expectedStatus,
        userId: session.user.id,
      });
    }
  } catch (error) {
    if (error instanceof MissingReportResolveConflictError) {
      return { error: "Estos reportes ya fueron revisados. Actualizá la cola.", ok: false };
    }
    console.error("[faltantes] No se pudo resolver el reporte:", error);
    return { error: "No se pudo resolver. Intentá de nuevo.", ok: false };
  }

  // A partir de acá la decisión YA está registrada. Auditoría y revalidación son
  // best-effort: si fallan, se registra el error pero NO se le dice al gerente
  // que falló, porque volvería a marcar algo ya hecho. El try/catch cubre
  // también `auditContextFromHeaders`, que lee headers() y sí puede lanzar.
  try {
    await recordAudit({
      action: REPORT_RESOLUTION_AUDIT[parsed.data.resolution],
      module: AUDIT_MODULES.FALTANTES,
      entity: "MissingReport",
      // Identificadores técnicos del grupo, sin nombres ni identidad de
      // reportantes: la traza permite reconstruir exactamente qué se resolvió.
      after: {
        status: parsed.data.resolution,
        reportIds: result.reportIds,
        reportCount: result.resolved,
      },
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch (error) {
    console.error("[faltantes] Se resolvió el reporte, pero no se pudo auditar:", error);
  }

  for (const path of [REVIEW_QUEUE_PATH, "/faltantes", "/entradas"]) {
    try {
      revalidatePath(path);
    } catch (error) {
      console.error("[faltantes] Se resolvió el reporte, pero no se pudo revalidar:", error);
    }
  }

  return { error: null, ok: true };
}

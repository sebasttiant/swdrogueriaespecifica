"use server";

import { revalidatePath } from "next/cache";

import {
  linkMissingReportSchema,
  missingReportSubmitSchema,
} from "@/features/faltantes/schema";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { requireCapability } from "@/lib/auth/require-role";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import {
  linkReportToProduct,
  MissingReportEmptyNameError,
  MissingReportLinkError,
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
  });
  if (!parsed.success) {
    // Surface the schema's specific message (empty vs too long), como
    // `orderMissingItemAction`, con un fallback estable.
    const message = parsed.error.issues[0]?.message ?? INVALID_NAME_MESSAGE;
    return { error: message, ok: false };
  }

  // El reporterId SIEMPRE sale de la sesión: cualquier `reporterId` que venga
  // en el FormData se ignora por construcción (no se lee).
  let report: Awaited<ReturnType<typeof submitMissingReport>>;
  try {
    report = await submitMissingReport({
      rawName: parsed.data.rawName,
      reporterId: session.user.id,
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
    reportIds: formData.getAll("reportIds"),
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
      reportIds: parsed.data.reportIds,
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

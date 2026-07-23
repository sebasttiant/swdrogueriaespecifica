"use server";

import { revalidatePath } from "next/cache";

import { missingReportSubmitSchema } from "@/features/faltantes/schema";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { requireCapability } from "@/lib/auth/require-role";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import {
  MissingReportEmptyNameError,
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

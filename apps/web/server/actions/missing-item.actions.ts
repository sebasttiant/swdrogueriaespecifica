"use server";

import { revalidatePath } from "next/cache";

import { requireActiveRole } from "@/lib/auth/require-role";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import { confirmMissingItemOk } from "@/server/services/missing-item.service";

export type MissingItemActionState = { error: string | null; ok: boolean };

export async function confirmMissingItemAction(
  _prev: MissingItemActionState,
  formData: FormData,
): Promise<MissingItemActionState> {
  const session = await requireActiveRole("SUPERADMIN", "ADMIN");
  const id = formData.get("id");
  const rawNote = formData.get("note");
  const note = typeof rawNote === "string" && rawNote.trim() ? rawNote.trim() : undefined;

  if (typeof id !== "string" || id.trim().length === 0) {
    return { error: "No se pudo identificar el faltante.", ok: false };
  }

  try {
    const result = await confirmMissingItemOk({
      id,
      confirmedById: session.user.id,
      note,
    });

    await recordAudit({
      action: AUDIT_ACTIONS.MISSING_CONFIRM_OK,
      module: AUDIT_MODULES.FALTANTES,
      entity: "MissingItem",
      entityId: result.item.id,
      after: { status: result.item.status, changed: result.changed },
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch (error) {
    console.error("[faltantes] No se pudo confirmar el faltante:", error);
    return { error: "No se pudo marcar OK. Intentá de nuevo.", ok: false };
  }

  revalidatePath("/faltantes");
  revalidatePath("/dashboard");
  return { error: null, ok: true };
}

export async function confirmMissingItemFormAction(
  formData: FormData,
): Promise<void> {
  await confirmMissingItemAction({ error: null, ok: false }, formData);
}

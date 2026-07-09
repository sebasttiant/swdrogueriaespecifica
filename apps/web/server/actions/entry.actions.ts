"use server";

import { revalidatePath } from "next/cache";

import { requireCapability } from "@/lib/auth/require-role";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";
import { inventoryEntryCreateSchema } from "@/features/entradas/schema";

// --------------------------------------------------------------------------
// Server Actions de entradas de inventario: Zod → requireCapability →
// service (atomic $transaction) → audit best-effort → revalidate.
// Roles permitidos: SUPERADMIN, ADMIN, OPERADOR — mismo gate que pendientes.
// La transacción (upsert lote + ledger + cierre de faltantes) vive en el
// service; acá solo orquestamos.
// --------------------------------------------------------------------------

export type EntryFormState = {
  error: string | null;
  ok: boolean;
  closedMissingCount?: number;
};

export async function createInventoryEntryAction(
  _prev: EntryFormState,
  formData: FormData,
): Promise<EntryFormState> {
  const session = await requireCapability("canCreateEntries");

  const parsed = inventoryEntryCreateSchema.safeParse({
    productId: formData.get("productId"),
    quantity: formData.get("quantity"),
    batchCode: formData.get("batchCode"),
    // FormData devuelve null cuando el campo no viene; lo normalizamos a
    // undefined para que el schema aplique sus reglas (fecha obligatoria).
    expiresAt: formData.get("expiresAt") ?? undefined,
    note: formData.get("note") ?? undefined,
  });

  if (!parsed.success) {
    return { error: "Revisá los datos de la entrada.", ok: false };
  }

  let closedMissingCount = 0;

  try {
    const result = await registerInventoryEntry({
      ...parsed.data,
      createdById: session.user.id,
    });

    closedMissingCount = result.closedMissingCount;

    const context = await auditContextFromHeaders(session.user.id);

    await recordAudit({
      action: AUDIT_ACTIONS.ENTRY_CREATE,
      module: AUDIT_MODULES.ENTRADAS,
      entity: "InventoryEntry",
      entityId: result.entry.id,
      after: {
        productId: parsed.data.productId,
        quantity: parsed.data.quantity,
        batchCode: parsed.data.batchCode,
        expiresAt: parsed.data.expiresAt.toISOString(),
      },
      context,
    });

    // Auditoría adicional best-effort: faltantes cerrados por esta entrada.
    if (closedMissingCount > 0) {
      await recordAudit({
        action: AUDIT_ACTIONS.MISSING_CLOSED_BY_ENTRY,
        module: AUDIT_MODULES.ENTRADAS,
        entity: "MissingItem",
        after: {
          productId: parsed.data.productId,
          closedCount: closedMissingCount,
        },
        context,
      });
    }
  } catch (error) {
    console.error("[entradas] No se pudo registrar la entrada:", error);
    return {
      error: "No se pudo registrar la entrada. Intentá de nuevo.",
      ok: false,
    };
  }

  revalidatePath("/entradas");
  revalidatePath("/productos");
  revalidatePath("/dashboard");
  revalidatePath("/faltantes");
  return { error: null, ok: true, closedMissingCount };
}

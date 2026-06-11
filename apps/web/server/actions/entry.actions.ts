"use server";

import { revalidatePath } from "next/cache";

import { requireActiveRole } from "@/lib/auth/require-role";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";
import { inventoryEntryCreateSchema } from "@/features/entradas/schema";

// --------------------------------------------------------------------------
// Server Actions de entradas de inventario: Zod → requireActiveRole →
// service (atomic $transaction) → audit best-effort → revalidate.
// Roles permitidos: SUPERADMIN, ADMIN, OPERADOR — mismo gate que pendientes.
// La transacción (upsert lote + ledger) vive en el service; acá solo orquestamos.
// --------------------------------------------------------------------------

export type EntryFormState = { error: string | null; ok: boolean };

export async function createInventoryEntryAction(
  _prev: EntryFormState,
  formData: FormData,
): Promise<EntryFormState> {
  const session = await requireActiveRole("SUPERADMIN", "ADMIN", "OPERADOR");

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

  try {
    const result = await registerInventoryEntry({
      ...parsed.data,
      createdById: session.user.id,
    });

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
  return { error: null, ok: true };
}

"use server";

import { revalidatePath } from "next/cache";

import { requireActiveRole } from "@/lib/auth/require-role";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import { registerPending } from "@/server/services/pending.service";
import { pendingCreateSchema } from "@/features/pendientes/schema";

// --------------------------------------------------------------------------
// Server Actions de pendientes (finas): Zod → requireActiveRole → service → audit.
// Registrar un pendiente requiere un usuario activo en DB (DB-authoritative guard).
// Un token JWT válido de un usuario desactivado es rechazado. Roles permitidos:
// SUPERADMIN, ADMIN, OPERADOR — todos deben tener active=true en la DB.
// La regla de déficit (genera faltante) vive en el service; acá solo auditamos
// cada efecto de forma best-effort.
// --------------------------------------------------------------------------

export type PendingFormState = { error: string | null; ok: boolean };

export async function createPendingAction(
  _prev: PendingFormState,
  formData: FormData,
): Promise<PendingFormState> {
  const session = await requireActiveRole("SUPERADMIN", "ADMIN", "OPERADOR");

  const parsed = pendingCreateSchema.safeParse({
    productId: formData.get("productId"),
    // Producto manual (opcional): cuando el operador carga uno fuera del catálogo.
    manualName: formData.get("manualName") ?? undefined,
    manualUnit: formData.get("manualUnit") ?? undefined,
    quantity: formData.get("quantity"),
    // FormData devuelve null cuando el campo no viene; lo normalizamos a
    // undefined para que el schema aplique sus reglas (texto opcional / fecha
    // obligatoria) en vez de coercer null a una fecha epoch válida.
    promisedAt: formData.get("promisedAt") ?? undefined,
    customerName: formData.get("customerName") ?? undefined,
    note: formData.get("note") ?? undefined,
  });

  if (!parsed.success) {
    return { error: "Revisá los datos del pendiente.", ok: false };
  }

  try {
    const result = await registerPending({
      ...parsed.data,
      createdById: session.user.id,
    });

    const context = await auditContextFromHeaders(session.user.id);

    // Producto manual creado al vuelo: lo auditamos como efecto propio para que
    // quede trazado quién metió un producto fuera del catálogo (needsReview).
    if (result.createdProduct) {
      await recordAudit({
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
      });
    }

    await recordAudit({
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
        note: parsed.data.note ?? null,
        manual: parsed.data.manual ?? null,
      },
      context,
    });

    // Si el stock no alcanzó, se generó un faltante automático: lo auditamos
    // como un efecto aparte para que la trazabilidad sea explícita.
    if (result.missingItem) {
      await recordAudit({
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
      });
    }
  } catch (error) {
    // No se filtra el detalle al usuario; se loguea en server.
    console.error("[pendientes] No se pudo registrar el pendiente:", error);
    return {
      error: "No se pudo registrar el pendiente. Intentá de nuevo.",
      ok: false,
    };
  }

  revalidatePath("/pendientes");
  revalidatePath("/faltantes");
  return { error: null, ok: true };
}

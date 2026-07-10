"use server";

import { revalidatePath } from "next/cache";

import { requireCapability } from "@/lib/auth/require-role";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import {
  cancelPendingCommitment,
  deliverPending,
  registerPending,
} from "@/server/services/pending.service";
import type { DeliveryRejection } from "@/features/pendientes/delivery-rules";
import {
  pendingCancelSchema,
  pendingCreateSchema,
  pendingDeliverSchema,
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

export type PendingFormState = { error: string | null; ok: boolean };

export async function createPendingAction(
  _prev: PendingFormState,
  formData: FormData,
): Promise<PendingFormState> {
  const session = await requireCapability("canCreatePendientes");

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

// --------------------------------------------------------------------------
// Ciclo de vida de entrega (Slice A): entregas parciales + cancelación.
// Mismo esqueleto que `confirmMissingItemAction`: Zod → requireCapability →
// service → audit best-effort → revalidate. El `customerName` del pendiente
// NUNCA se guarda en el payload de auditoría.
// --------------------------------------------------------------------------

const DELIVERY_REJECTION_MESSAGES: Record<DeliveryRejection, string> = {
  ALREADY_DELIVERED: "Este pendiente ya fue entregado.",
  ALREADY_CANCELLED: "Este pendiente está cancelado.",
  NON_POSITIVE_QUANTITY: "Ingresá una cantidad válida.",
  EXCEEDS_REMAINING: "La cantidad supera lo que resta por entregar.",
};

const CANCEL_REJECTION_MESSAGES: Record<"ALREADY_DELIVERED" | "ALREADY_CANCELLED", string> = {
  ALREADY_DELIVERED: "No se puede cancelar un pendiente ya entregado.",
  ALREADY_CANCELLED: "Este pendiente ya está cancelado.",
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
    });

		if (result.rejection) {
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
    console.error("[pendientes] No se pudo registrar la entrega:", error);
    return {
      error: "No se pudo registrar la entrega. Intentá de nuevo.",
      ok: false,
    };
  }

  revalidatePath("/pendientes");
  revalidatePath("/dashboard");
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
    });

		if (result.rejection) {
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
    console.error("[pendientes] No se pudo cancelar el pendiente:", error);
    return {
      error: "No se pudo cancelar el pendiente. Intentá de nuevo.",
      ok: false,
    };
  }

  revalidatePath("/pendientes");
  revalidatePath("/dashboard");
  return { error: null, ok: true };
}

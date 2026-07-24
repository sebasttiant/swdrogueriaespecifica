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
  setPendingManagementStatus,
} from "@/server/services/pending.service";
import type { DeliveryRejection } from "@/features/pendientes/delivery-rules";
import {
  pendingCancelSchema,
  pendingCreateSchema,
  pendingDeliverSchema,
  pendingManagementStatusSchema,
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
// Mismo esqueleto que `orderMissingItemAction`: Zod → requireCapability →
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
  });

  if (!parsed.success) {
    return { error: "No se pudo identificar el pendiente o el estado.", ok: false };
  }

  try {
    const result = await setPendingManagementStatus({
      id: parsed.data.id,
      status: parsed.data.status,
    });

    // Rechazo de negocio: alguien con la capacidad intentó gestionar un
    // pendiente que ya no lo admite. Se audita como FAILURE con el estado
    // intentado para que la traza exista.
    if (result.rejection) {
      await recordAudit({
        action: AUDIT_ACTIONS.PENDING_STATUS_CHANGE,
        module: AUDIT_MODULES.PENDIENTES,
        entity: "Pending",
        entityId: parsed.data.id,
        result: "FAILURE",
        after: { reason: result.rejection, status: parsed.data.status },
        context: await auditContextFromHeaders(session.user.id),
      });

      revalidatePath("/pendientes");
      revalidatePath("/dashboard");
      return {
        error: MANAGEMENT_STATUS_REJECTION_MESSAGES[result.rejection],
        ok: false,
      };
    }

    await recordAudit({
      action: AUDIT_ACTIONS.PENDING_STATUS_CHANGE,
      module: AUDIT_MODULES.PENDIENTES,
      entity: "Pending",
      entityId: parsed.data.id,
      after: { status: parsed.data.status },
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch (error) {
    console.error("[pendientes] No se pudo actualizar el estado de gestión:", error);
    return {
      error: "No se pudo actualizar el estado. Intentá de nuevo.",
      ok: false,
    };
  }

  // AGOTADO saca al pendiente de los estados alertables: revalidar también el
  // dashboard para que los contadores de vencidos/próximos/urgentes no queden
  // desfasados.
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

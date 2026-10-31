"use server";

import { revalidatePath } from "next/cache";

import { inventoryAdjustmentSchema } from "@/features/inventario/adjustment-schema";
import { checkCapability, type CapabilityDenial } from "@/lib/auth/require-role";
import {
  AdjustmentBelowReservedError,
  AdjustmentBelowZeroError,
  AdjustmentIdempotencyConflictError,
  BatchNotFoundError,
  adjustBatchQuantity,
} from "@/server/services/inventory-adjustment.service";

// --------------------------------------------------------------------------
// Server Action del ajuste de inventario.
//
// Fina a propósito: Zod → capability → servicio → revalidate. El servicio ya
// deja el asiento de auditoría DENTRO de la misma transacción que mueve el
// número. Auditar de nuevo acá dejaría dos asientos por un solo hecho.
// --------------------------------------------------------------------------

export type InventoryAdjustmentFormState = {
  error: string | null;
  ok: boolean;
};

function authorizationMessage(reason: CapabilityDenial): string {
  if (reason === "NO_SESSION") {
    return "Tu sesión venció. Abrí el ingreso en otra pestaña, iniciá sesión de nuevo y volvé acá.";
  }
  if (reason === "INACTIVE") {
    return "Tu usuario está inactivo. Pedile a un administrador que lo reactive.";
  }
  return "Tu usuario no tiene permiso para ajustar inventario. Pedile a un administrador que lo habilite.";
}

function messageForAdjustmentError(error: unknown): string {
  if (error instanceof BatchNotFoundError) {
    return "Ese lote ya no existe. Recargá la página.";
  }
  if (error instanceof AdjustmentBelowZeroError) {
    return "La cantidad no puede quedar en negativo.";
  }
  if (error instanceof AdjustmentBelowReservedError) {
    return `Hay ${error.reserved} unidad(es) prometidas a clientes. No se puede dejar el lote por debajo de eso.`;
  }
  if (error instanceof AdjustmentIdempotencyConflictError) {
    return "Este intento ya se usó con otros datos. Cerrá el formulario y abrilo de nuevo.";
  }
  if (error instanceof RangeError) {
    if (error.message.includes("matches current quantity")) {
      return "La cantidad contada es igual a la del sistema: no hay nada que corregir.";
    }
    return "La cantidad indicada no es válida.";
  }
  return "No se pudo guardar el ajuste. Intentá de nuevo.";
}

export async function adjustBatchQuantityAction(
  _prev: InventoryAdjustmentFormState,
  formData: FormData,
): Promise<InventoryAdjustmentFormState> {
  const authorization = await checkCapability("canAdjustInventory");
  if (!authorization.ok) {
    return { error: authorizationMessage(authorization.reason), ok: false };
  }

  const parsed = inventoryAdjustmentSchema.safeParse({
    batchId: formData.get("batchId"),
    productId: formData.get("productId"),
    targetQuantity: formData.get("targetQuantity"),
    reason: formData.get("reason"),
    note: formData.get("note") ?? undefined,
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ?? "Revisá los datos del ajuste.",
      ok: false,
    };
  }

  try {
    await adjustBatchQuantity({
      batchId: parsed.data.batchId,
      actorId: authorization.session.user.id,
      targetQuantity: parsed.data.targetQuantity,
      reason: parsed.data.reason,
      note: parsed.data.note ?? null,
      idempotencyKey: parsed.data.idempotencyKey,
    });
  } catch (error) {
    console.error("[inventory.adjust] failed", error);
    return { error: messageForAdjustmentError(error), ok: false };
  }

  revalidatePath(`/productos/${parsed.data.productId}`);
  revalidatePath("/productos");
  return { error: null, ok: true };
}

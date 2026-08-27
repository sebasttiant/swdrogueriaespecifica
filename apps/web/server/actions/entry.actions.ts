"use server";

import { revalidatePath } from "next/cache";

import { requireCapability } from "@/lib/auth/require-role";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import { findOrCreateLaboratory } from "@/server/repositories/laboratory.repository";
import {
  LaboratoryEvidenceConflictError,
  registerInventoryEntry,
} from "@/server/services/inventory-entry.service";
import { inventoryEntryCreateSchema } from "@/features/entradas/schema";

// --------------------------------------------------------------------------
// Server Actions de entradas de inventario: Zod → requireCapability →
// service (atomic $transaction) → audit best-effort → revalidate.
// Roles permitidos: SUPERADMIN, ADMIN, BODEGA (el circuito de recepción es de
// gerencia y bodega; OPERADOR/SUPERVISOR solo ven la lista). La transacción
// (upsert lote + ledger + cierre de faltantes) vive en el service; acá solo
// orquestamos.
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
    receivedLaboratoryId: formData.get("receivedLaboratoryId") ?? undefined,
    receivedLaboratoryName: formData.get("receivedLaboratoryName") ?? undefined,
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) {
    return { error: "Revisá los datos de la entrada.", ok: false };
  }

  // ------------------------------------------------------------------------
  // Resolución del laboratorio recibido.
  //
  // Bodega escribe un nombre y manda; no tiene por qué saber que atrás hay un
  // catálogo. Si eligió de la lista ya viene el id y no hay nada que resolver.
  // Se hace ANTES de abrir la transacción: si el laboratorio no se puede
  // resolver, no tiene sentido empezar a mover stock.
  // ------------------------------------------------------------------------
  const { receivedLaboratoryName, ...entryData } = parsed.data;
  let receivedLaboratoryId = entryData.receivedLaboratoryId;

  if (!receivedLaboratoryId && receivedLaboratoryName) {
    try {
      const resolved = await findOrCreateLaboratory({
        name: receivedLaboratoryName,
        commandKey: `entry:${session.user.id}:${entryData.idempotencyKey}`,
      });
      receivedLaboratoryId = resolved.laboratory.id;
    } catch (error) {
      console.error("[entradas] No se pudo resolver el laboratorio:", error);
      return {
        error: "No se pudo resolver el laboratorio. Intentá de nuevo.",
        ok: false,
      };
    }
  }

  let allocatedMissingCount = 0;

  try {
    const result = await registerInventoryEntry({
      ...entryData,
      ...(receivedLaboratoryId ? { receivedLaboratoryId } : {}),
      createdById: session.user.id,
    });

    allocatedMissingCount = result.allocatedMissingCount;

    const context = await auditContextFromHeaders(session.user.id);

    await recordAudit({
      action: AUDIT_ACTIONS.ENTRY_CREATE,
      module: AUDIT_MODULES.ENTRADAS,
      entity: "InventoryEntry",
      entityId: result.entry.id,
      after: {
        productId: entryData.productId,
        quantity: entryData.quantity,
        batchCode: entryData.batchCode,
        expiresAt: entryData.expiresAt.toISOString(),
        receivedLaboratoryId: receivedLaboratoryId ?? null,
      },
      context,
    });

    // Auditoría adicional best-effort: faltantes cerrados por esta entrada.
    if (allocatedMissingCount > 0) {
      await recordAudit({
        action: AUDIT_ACTIONS.MISSING_CLOSED_BY_ENTRY,
        module: AUDIT_MODULES.ENTRADAS,
        entity: "MissingItem",
        after: {
          productId: entryData.productId,
          allocatedCount: allocatedMissingCount,
        },
        context,
      });
    }
  } catch (error) {
    // El conflicto de evidencia NO es una falla del sistema: es un dato que no
    // cuadra y que solo la persona que tiene la caja delante puede resolver.
    // Por eso se le nombra el lote y el laboratorio que ya quedó registrado,
    // nunca un id interno, que no le sirve para nada.
    if (error instanceof LaboratoryEvidenceConflictError) {
      const registrado = error.existingLaboratoryName
        ? `el laboratorio ${error.existingLaboratoryName}`
        : "otro laboratorio";
      return {
        error: `El lote ${error.batchCode} ya se recibió con ${registrado}. Verificá la caja: si el laboratorio es distinto, usá otro código de lote.`,
        ok: false,
      };
    }
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
  return { error: null, ok: true, closedMissingCount: allocatedMissingCount };
}

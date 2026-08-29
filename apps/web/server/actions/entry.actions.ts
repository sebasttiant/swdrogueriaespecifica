"use server";

import { revalidatePath } from "next/cache";

import { requireCapability } from "@/lib/auth/require-role";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import {
  LaboratoryEvidenceConflictError,
  LaboratoryNameResolutionError,
  ProductIdentityRequiredError,
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
  /**
   * El producto al que hay que completarle el SKU.
   *
   * Va aparte del mensaje para que la pantalla pueda enlazarlo. Decir
   * "completalo en Productos" y dejar que lo busque a mano entre nombres casi
   * idénticos repite el problema que hizo elegir el equivocado.
   */
  resolveSkuForProductId?: string;
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

  // El nombre del laboratorio viaja CRUDO al servicio. Bodega escribe un nombre
  // y manda; no tiene por qué saber que atrás hay un catálogo.
  //
  // Acá se resolvía antes de llamar al servicio, y eso creaba el laboratorio
  // fuera de la transacción de inventario: una entrada que después se rechazaba
  // —payload de idempotencia distinto, evidencia en conflicto— dejaba en el
  // catálogo un laboratorio que nadie pidió. Resolver adentro es lo que hace
  // que el rollback también se lo lleve.
  const entryData = parsed.data;

  let allocatedMissingCount = 0;

  try {
    const result = await registerInventoryEntry({
      ...entryData,
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
        // Lo que la persona pidió, que es lo que hay que poder auditar. El id
        // resuelto lo decide el servicio y ya queda en el lote.
        receivedLaboratoryId: entryData.receivedLaboratoryId ?? null,
        receivedLaboratoryName: entryData.receivedLaboratoryName ?? null,
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
    // Sin SKU no entra mercadería: cargar stock contra un producto sin identidad
    // crea inventario que después nadie puede cuadrar contra Orion. El mensaje
    // nombra el producto y dice DÓNDE resolverlo — quien recibe la caja tiene el
    // código impreso encima y puede completarlo ahora mismo.
    if (error instanceof ProductIdentityRequiredError) {
      return {
        error: `"${error.productName}" todavía no tiene SKU (código de Orion). Completalo y volvé a registrar la entrada.`,
        ok: false,
        resolveSkuForProductId: error.productId,
      };
    }
    // El nombre resolvió a un laboratorio que no es el que se pidió. No se
    // adjunta igual: sería inventarle al lote una evidencia que nadie observó.
    if (error instanceof LaboratoryNameResolutionError) {
      return {
        error: `No se pudo registrar "${error.requestedName}" como laboratorio. Buscalo en la lista y seleccionalo.`,
        ok: false,
      };
    }
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

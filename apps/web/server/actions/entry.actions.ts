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
  ProductNotFoundError,
  ProductVersionConflictError,
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
  /**
   * La fotografia ACTUAL del producto, cuando la entrada se rechazo porque
   * cambio en el medio.
   *
   * Viaja para que la pantalla pueda mostrar lo que el producto dice ahora y
   * ofrecer adoptarlo como UN ACTO EXPLICITO de la persona. Adoptarlo solo
   * dejaria pasar el reintento sin que nadie haya vuelto a mirar la caja, que
   * es el mismo agujero que el control de versiones cierra.
   */
  conflict?: {
    /**
     * A QUE producto pertenece este conflicto.
     *
     * Sin el, la pantalla no puede distinguir "cambio el producto que estoy
     * cargando" de "cambio otro". La identidad que vuelve aca describe UNA fila
     * concreta; aplicarla sobre otra afirmaria algo que esa otra fila no dice.
     */
    productId: string;
    /** El nombre tambien es catalogo: una edicion pudo cambiarlo. */
    name: string;
    sku: string | null;
    presentation: string;
    identityVersion: number;
    catalogVersion: number;
  };
};

/**
 * El mensaje del conflicto, en español neutral.
 *
 * Nombra QUE cambio y CUANTO vale ahora. "El producto cambió, intenta de
 * nuevo" manda a reintentar a ciegas contra un dato que no se leyo.
 */
function conflictMessage(error: ProductVersionConflictError): string {
  const { product } = error;
  if (error.kind === "identity") {
    return `El SKU de "${product.name}" cambió mientras registrabas la entrada. Ahora es ${product.orionCode ?? "ninguno"}. Verifica el SKU y la presentación contra la caja antes de confirmar.`;
  }
  return `Los datos de "${product.name}" cambiaron mientras registrabas la entrada. Presentación actual: ${product.unit}. Verifica el SKU y la presentación contra la caja antes de confirmar.`;
}

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
    expectedIdentityVersion: formData.get("expectedIdentityVersion"),
    expectedCatalogVersion: formData.get("expectedCatalogVersion"),
    displayedSku: formData.get("displayedSku") ?? undefined,
    displayedPresentation: formData.get("displayedPresentation") ?? undefined,
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
  const { displayedSku, displayedPresentation, ...entryData } = parsed.data;

  let allocatedMissingCount = 0;

  try {
    const result = await registerInventoryEntry({
      ...entryData,
      createdById: session.user.id,
    });

    allocatedMissingCount = result.allocatedMissingCount;

    // Un reintento idempotente NO se audita. La entrada ya tiene su fila de
    // ENTRY_CREATE; escribir una segunda afirmaria dos creaciones del mismo
    // registro, y quien despues lea la auditoria para cuadrar el inventario
    // contaria dos veces una mercaderia que entro una sola.
    if (result.idempotent) {
      revalidatePath("/entradas");
      return { error: null, ok: true, closedMissingCount: 0 };
    }

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
        // La identidad AUTORITATIVA contra la que se escribio, con las dos
        // versiones que se validaron: es lo que permite reconstruir despues
        // contra que producto entro esta caja.
        sku: result.product?.orionCode ?? null,
        presentation: result.product?.unit ?? null,
        identityVersion: result.product?.identityVersion ?? null,
        catalogVersion: result.product?.catalogVersion ?? null,
        // Y lo que la persona tenia DELANTE al confirmar, que es una pregunta
        // distinta de lo que decia el catalogo.
        displayedSku: displayedSku ?? null,
        displayedPresentation: displayedPresentation ?? null,
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
    if (error instanceof ProductNotFoundError) {
      return {
        error: "El producto ya no está disponible. Actualiza la pantalla y vuelve a elegirlo.",
        ok: false,
      };
    }
    // El producto cambio mientras la caja estaba sobre el mostrador. No se
    // registra contra la fotografia vieja: se le dice a la persona QUE cambio.
    if (error instanceof ProductVersionConflictError) {
      return {
        error: conflictMessage(error),
        ok: false,
        conflict: {
          productId: error.product.id,
          name: error.product.name,
          sku: error.product.orionCode,
          presentation: error.product.unit,
          identityVersion: error.product.identityVersion,
          catalogVersion: error.product.catalogVersion,
        },
      };
    }
    if (error instanceof ProductIdentityRequiredError) {
      return {
        error: `"${error.productName}" todavía no tiene SKU (código de Orión). Completalo y volvé a registrar la entrada.`,
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

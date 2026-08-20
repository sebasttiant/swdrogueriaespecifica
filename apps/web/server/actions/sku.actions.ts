"use server";

import { revalidatePath } from "next/cache";

import {
  SKU_IDENTITY_CONCURRENCY_MESSAGE,
  messageForIdentityError,
} from "@/features/productos/sku-identity-messages";
import { orionLinkSchema } from "@/features/productos/schema";
import type { Capability } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import { SkuIdentityError } from "@/server/domain/catalog/sku-identity";
import { SkuConcurrencyError } from "@/server/repositories/sku-review.repository";
import { auditContextFromHeaders } from "@/server/services/audit.service";
import { linkOrionCode } from "@/server/services/sku-onboarding.service";

// --------------------------------------------------------------------------
// Server Action del vínculo con el código Orion.
//
// FINA a propósito: Zod → capability → servicio → revalidate. Toda la regla
// —qué se puede pisar, qué es inmutable, quién puede acuñar— ya vive en
// `sku-identity.ts` y `sku-onboarding.service.ts`, con sus tests contra
// PostgreSQL real. Si acá apareciera una decisión de negocio, estaría
// duplicada, y las dos copias se van a separar el día que alguien toque una.
//
// TAMPOCO audita: `linkOrionCode` escribe el asiento DENTRO de la misma
// transacción que el vínculo. Auditar de nuevo acá dejaría dos asientos por
// un solo hecho, y el de afuera sobreviviría a un rollback del de adentro.
//
// DOS GUARDS, a propósito y no por duplicación:
//   · `requireCapability` es el portón — DB-authoritative, rechaza un JWT
//     viejo de alguien a quien degradaron.
//   · `assertCanOnboardSku`, adentro del servicio, es la cerradura: protege
//     al servicio de cualquier otro llamador, hoy y mañana.
//
// Hoy `canManageProducts` es de ADMIN y SUPERADMIN; el dominio además admite
// BODEGA. La diferencia se cierra sola cuando entre el PR #151, que le da esa
// capacidad a bodega. Mientras tanto el portón es MÁS angosto que la
// cerradura, que es el lado seguro para equivocarse.
// --------------------------------------------------------------------------

export type OrionLinkFormState = { error: string | null; ok: boolean };

export async function linkOrionCodeAction(
  _prev: OrionLinkFormState,
  formData: FormData,
): Promise<OrionLinkFormState> {
  return runOrionIdentityAction(
    { capability: "canManageProducts", intent: "LINK", label: "Vínculo Orion" },
    formData,
  );
}

/**
 * Corregir un código de Orion mal cargado.
 *
 * Portón propio (`canFixProductIdentity`) y no `canManageProducts`: SUPERVISOR
 * corrige sin poder crear ni editar productos. Ver `lib/auth/permissions.ts`.
 *
 * Comparte todo lo demás con el vínculo porque es la misma operación con otra
 * intención; dos copias de este cuerpo se separarían el día que alguien toque
 * una sola.
 */
export async function fixOrionCodeAction(
  _prev: OrionLinkFormState,
  formData: FormData,
): Promise<OrionLinkFormState> {
  return runOrionIdentityAction(
    { capability: "canFixProductIdentity", intent: "FIX", label: "Corrección Orion" },
    formData,
  );
}

async function runOrionIdentityAction(
  operation: {
    capability: Capability;
    intent: "LINK" | "FIX";
    /** Cómo se nombra esta operación en los logs del servidor. */
    label: string;
  },
  formData: FormData,
): Promise<OrionLinkFormState> {
  const session = await requireCapability(operation.capability);

  const parsed = orionLinkSchema.safeParse({
    expectedVersion: formData.get("expectedVersion"),
    orionCode: formData.get("orionCode"),
    productId: formData.get("productId"),
  });

  if (!parsed.success) {
    // El mensaje del schema, no uno genérico: cada rechazo ya sabe explicar
    // qué está mal con lo que se escribió.
    return {
      error: parsed.error.issues[0]?.message ?? "Revisá los datos del vínculo.",
      ok: false,
    };
  }

  try {
    await linkOrionCode({
      actor: { id: session.user.id, role: session.user.role },
      context: await auditContextFromHeaders(session.user.id),
      expectedVersion: parsed.data.expectedVersion,
      // SOLO `productId`. Mandar dos identidades exactas a la vez hace que
      // `resolveIdentityMode` tire `AMBIGUOUS_MODE`: no adivina por nosotros.
      identity: { productId: parsed.data.productId },
      // Nunca RELINK desde acá. Mudarle el código a OTRO producto es una
      // decisión explícita con su propia pantalla, no algo que salga de
      // apretar "vincular" o "corregir" sin querer.
      intent: operation.intent,
      orionCode: parsed.data.orionCode,
    });
  } catch (error) {
    // TODA falla se loguea con QUÉ se intentaba y QUIÉN lo intentaba, no solo
    // la desconocida. Sin esto, un "no me deja vincular" por teléfono no se
    // puede atar a ningún intento, y un conflicto que se repite —la carrera
    // por el mismo código -- no deja rastro para saber cuán seguido pasa.
    // Es un producto y su código: nada de esto es dato personal.
    const intento = {
      actorId: session.user.id,
      orionCode: parsed.data.orionCode,
      productId: parsed.data.productId,
    };

    if (error instanceof SkuConcurrencyError) {
      console.warn(`[productos] ${operation.label}: perdió el compare-and-set`, intento);
      return { error: SKU_IDENTITY_CONCURRENCY_MESSAGE, ok: false };
    }
    if (error instanceof SkuIdentityError) {
      console.warn(`[productos] ${operation.label} rechazada:`, error.code, intento);
      return { error: messageForIdentityError(error.code), ok: false };
    }
    // Cualquier otra cosa no se le filtra al operador: queda en el server.
    console.error(`[productos] ${operation.label}: no se pudo escribir`, intento, error);
    return { error: messageForIdentityError(undefined), ok: false };
  }

  // El vínculo YA está escrito y es durable. Si refrescar la caché falla, eso
  // no puede convertirse en un error en pantalla: el operador vería "no se
  // pudo" para algo que sí se hizo, y volvería a intentarlo sobre una identidad
  // que ya quedó puesta. Lo peor que pasa acá es que vea la pantalla vieja un
  // rato, y para eso alcanza con recargar.
  try {
    revalidatePath(`/productos/${parsed.data.productId}`);
    revalidatePath("/productos");
  } catch (error) {
    console.error(`[productos] ${operation.label} escrita, pero falló el refresco:`, error);
  }

  return { error: null, ok: true };
}

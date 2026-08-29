"use server";

import { revalidatePath } from "next/cache";

import { requireCapability } from "@/lib/auth/require-role";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import { markMissingItemArrived } from "@/server/repositories/missing-item.repository";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";

// --------------------------------------------------------------------------
// "Ya llegó a bodega": la mercadería está físicamente acá.
//
// NO es "disponible para entregar". Ese salto lo da el registro de la entrada,
// que carga lote, vencimiento y cantidad real, y recién ahí hay stock. Marcar
// la llegada solo mueve el faltante de PEDIDO a EN_BODEGA y avisa al pendiente
// que su mercadería está en el local — el verde de la reunión: "ya llegó, pero
// no lo cargaron al sistema".
//
// Por eso NO crea inventario y NO encola aviso de disponibilidad. Notificarle
// al vendedor "ya llegó" cuando todavía no puede entregar nada lo mandaría a
// llamar a un cliente que va a venir a buscar algo que el sistema no tiene.
// --------------------------------------------------------------------------

export type ReceiverActionState = { error: string | null; ok: boolean };

/**
 * Marca la llegada física de un faltante ya pedido.
 *
 * Recibe SOLO el id. El actor sale de la sesión: aceptar un `arrivedById` del
 * cliente permitiría firmar la recepción a nombre de otro, y la auditoría de
 * quién recibió qué es justamente lo que este registro existe para conservar.
 */
export async function markMissingItemArrivedAction(
  _prev: ReceiverActionState,
  formData: FormData,
): Promise<ReceiverActionState> {
  const session = await requireCapability("canReceiveMissingItems");

  const missingItemId = formData.get("missingItemId");
  if (typeof missingItemId !== "string" || missingItemId.length === 0) {
    return { error: "Falta el faltante que llegó.", ok: false };
  }

  const arrivedAt = new Date();
  let changed = 0;
  try {
    changed = await prisma.$transaction((tx) =>
      markMissingItemArrived(tx, {
        id: missingItemId,
        arrivedById: session.user.id,
        arrivedAt,
      }),
    );
  } catch {
    return { error: "No se pudo registrar la llegada. Reintentá.", ok: false };
  }

  // `changed === 0` es la respuesta del compare-and-set: la fila ya no estaba
  // en PEDIDO. Puede ser que otro la marcó primero —dos personas descargando el
  // mismo pedido— o que nunca se compró. En los dos casos el estado que hay es
  // el correcto y NO se pisa; se dice qué pasó y se deja mirar de nuevo.
  if (changed === 0) {
    return {
      error:
        "Ese faltante ya no está esperando: puede que alguien lo marcara antes. Actualizá la lista.",
      ok: false,
    };
  }

  // La auditoría no puede tumbar una recepción ya escrita: la caja está en el
  // depósito con o sin registro del evento.
  try {
    await recordAudit({
      action: AUDIT_ACTIONS.MISSING_ITEM_ARRIVED,
      module: AUDIT_MODULES.FALTANTES,
      entity: "MissingItem",
      entityId: missingItemId,
      after: { status: "EN_BODEGA", arrivedAt: arrivedAt.toISOString() },
      // El actor sale de la sesión, nunca del formulario: firmar la recepción a
      // nombre de otro rompería lo único que este registro conserva.
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch {
    // Silencio deliberado: ver el comentario de arriba.
  }

  revalidatePath("/revision-faltantes");
  return { error: null, ok: true };
}

"use server";

import { revalidatePath } from "next/cache";

import { requireCapability } from "@/lib/auth/require-role";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  manualMissingItemCreateSchema,
  discardMissingItemsSchema,
  markMissingItemsOrderedSchema,
  orderMissingItemSchema,
} from "@/features/faltantes/schema";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import {
  createManualMissingItem,
  discardMissingItems,
  markMissingItemsOrdered,
  orderMissingItem,
  type OrderMissingItemInput,
  type OrderRejection,
} from "@/server/services/missing-item.service";
import {
  getActiveProductsForMissingItem,
  type ActiveProductOption,
} from "@/server/services/product.service";

export type MissingItemActionState = { error: string | null; ok: boolean };

export type MissingItemProductSearchResult = {
  items: ActiveProductOption[];
  nextCursor: string | null;
};

export async function searchActiveProductsForMissingItemAction(
  rawQuery: string,
  cursor?: string | null,
): Promise<MissingItemProductSearchResult> {
  await requireCapability("canCreateMissingItems");

  const q = rawQuery.trim();
  if (!q) return { items: [], nextCursor: null };

  return getActiveProductsForMissingItem({ q, cursor });
}

export async function createMissingItemAction(
  _prev: MissingItemActionState,
  formData: FormData,
): Promise<MissingItemActionState> {
  const session = await requireCapability("canCreateMissingItems");

  const parsed = manualMissingItemCreateSchema.safeParse({
    productId: formData.get("productId"),
    sellerCode: formData.get("sellerCode") ?? undefined,
    note: formData.get("note") ?? undefined,
  });

  if (!parsed.success) {
    return { error: "Revisá los datos del faltante.", ok: false };
  }

  let item: Awaited<ReturnType<typeof createManualMissingItem>>;
  try {
    item = await createManualMissingItem({
      ...parsed.data,
      createdById: session.user.id,
    });
  } catch (error) {
    console.error("[faltantes] No se pudo registrar el faltante manual:", error);
    return { error: "No se pudo registrar el faltante. Intentá de nuevo.", ok: false };
  }

  try {
    await recordAudit({
      action: AUDIT_ACTIONS.MISSING_CREATE,
      module: AUDIT_MODULES.FALTANTES,
      entity: "MissingItem",
      entityId: item.id,
      after: {
        productId: item.productId,
        quantity: item.quantity,
        sellerCode: item.sellerCode ?? null,
        originId: null,
        source: "manual",
        hasNote: Boolean(parsed.data.note),
      },
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch (error) {
    console.error("[faltantes] El faltante se creó, pero no se pudo auditar:", error);
  }

  for (const path of ["/faltantes", "/dashboard"]) {
    try {
      revalidatePath(path);
    } catch (error) {
      console.error("[faltantes] El faltante se creó, pero no se pudo revalidar:", error);
    }
  }
  return { error: null, ok: true };
}

// Rechazos de negocio del pedido → mensaje en español para el gerente.
//
// ALREADY_CONFIRMED se dispara sobre filas con `confirmedAt`: registros del
// camino viejo, donde gerencia YA había pedido pero sin registrar proveedor.
// Su clasificación y su cierre por entrada se resuelven en C2 y C3.
const ORDER_REJECTION_MESSAGES: Record<OrderRejection, string> = {
  ALREADY_ORDERED: "Este faltante ya fue pedido.",
  ALREADY_CONFIRMED: "Este faltante ya figura como pedido y no se puede volver a pedir.",
  NOT_ORDERABLE: "Este faltante no se puede pedir desde su estado actual.",
  SUPPLIER_NOT_FOUND: "No se encontró el proveedor seleccionado.",
};

// --------------------------------------------------------------------------
// Pedido de un faltante a un proveedor. Solo gerencia (canOrderMissingItems).
// Crear un proveedor nuevo al vuelo es un eje aparte (canManageSuppliers) y se
// verifica server-side, nunca confiando en una prop de la UI.
// --------------------------------------------------------------------------
export async function orderMissingItemAction(
  _prev: MissingItemActionState,
  formData: FormData,
): Promise<MissingItemActionState> {
  const session = await requireCapability("canOrderMissingItems");

  const parsed = orderMissingItemSchema.safeParse({
    missingItemId: formData.get("missingItemId"),
    // Ausente → undefined (no null): así el schema da el mensaje "requerido" en
    // vez de coaccionar null a 0 y reportar "mayor a cero".
    orderedQuantity: formData.get("orderedQuantity") ?? undefined,
    // FormData devuelve null cuando el campo no viene; lo normalizamos a
    // undefined para que el schema aplique sus reglas.
    supplierId: formData.get("supplierId") ?? undefined,
    name: formData.get("name") ?? undefined,
    phone: formData.get("phone") ?? undefined,
    address: formData.get("address") ?? undefined,
    email: formData.get("email") ?? undefined,
  });

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Revisá los datos del pedido.";
    return { error: message, ok: false };
  }

  const data = parsed.data;

  // La rama la decide el servidor: `supplierId` con valor → proveedor
  // existente; vacío/ausente → proveedor nuevo.
  let supplier: OrderMissingItemInput["supplier"];
  if (data.supplierId) {
    supplier = { kind: "existing", supplierId: data.supplierId };
  } else {
    // Crear un proveedor nuevo exige la capacidad separada. Fuera del try:
    // debe rechazar (redirigir) igual que el gate de arriba, no devolver error.
    await requireCapability("canManageSuppliers");
    // `superRefine` ya garantiza el nombre en esta rama; validamos para
    // estrechar el tipo sin usar aserciones.
    if (!data.name) {
      return { error: "El nombre del proveedor es obligatorio.", ok: false };
    }
    supplier = {
      kind: "new",
      name: data.name,
      phone: data.phone,
      address: data.address,
      email: data.email,
    };
  }

  // Solo la transacción del pedido va dentro del try cuyo catch reporta fallo:
  // una vez que el pedido se persistió, un error posterior de auditoría o
  // revalidación NO debe decirle al gerente que el pedido falló (un reintento
  // chocaría con ALREADY_ORDERED).
  let result: Awaited<ReturnType<typeof orderMissingItem>>;
  try {
    result = await orderMissingItem({
      missingItemId: data.missingItemId,
      userId: session.user.id,
      orderedQuantity: data.orderedQuantity,
      supplier,
    });
  } catch (error) {
    console.error("[faltantes] No se pudo pedir el faltante:", error);
    return { error: "No se pudo registrar el pedido. Intentá de nuevo.", ok: false };
  }

  // Intento real de pedir sobre un faltante que no lo admitía: se audita como
  // FAILURE con el código de rechazo. `supplierKind` deja ver si se intentó con
  // un proveedor existente o creando uno nuevo, sin guardar sus datos de
  // contacto (nombre/teléfono/dirección/mail vienen del formulario).
  if (result.rejection) {
    try {
      await recordAudit({
        action: AUDIT_ACTIONS.MISSING_ITEM_ORDERED,
        module: AUDIT_MODULES.FALTANTES,
        entity: "MissingItem",
        entityId: data.missingItemId,
        result: "FAILURE",
        after: { reason: result.rejection, supplierKind: supplier.kind },
        context: await auditContextFromHeaders(session.user.id),
      });
    } catch (error) {
      console.error("[faltantes] El rechazo del pedido no se pudo auditar:", error);
    }

    revalidateOrderViews();
    return { error: ORDER_REJECTION_MESSAGES[result.rejection], ok: false };
  }

  // El pedido YA se persistió. La auditoría es best-effort: si falla, se registra
  // el error pero el pedido sigue siendo un éxito para el gerente.
  try {
    await recordAudit({
      action: AUDIT_ACTIONS.MISSING_ITEM_ORDERED,
      module: AUDIT_MODULES.FALTANTES,
      entity: "MissingItem",
      entityId: data.missingItemId,
      // Sin PII del cliente: solo metadatos del pedido, con la cantidad pedida.
      after: {
        supplierId: result.item?.supplierId ?? null,
        supplierCreated: supplier.kind === "new",
        status: result.item?.status ?? null,
        orderedQuantity: data.orderedQuantity,
      },
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch (error) {
    console.error("[faltantes] El pedido se registró, pero no se pudo auditar:", error);
  }

  revalidateOrderViews();
  return { error: null, ok: true };
}

// Revalida las vistas que muestran el estado del pedido, sin dejar que un fallo
// de caché convierta un pedido ya persistido en un error para el usuario.
function revalidateOrderViews() {
  for (const path of ["/faltantes", "/dashboard"]) {
    try {
      revalidatePath(path);
    } catch (error) {
      console.error("[faltantes] El pedido se registró, pero no se pudo revalidar:", error);
    }
  }
}

/**
 * Descarte masivo de faltantes duplicados o que ya no hacen falta.
 *
 * Gateada con `canOrderMissingItems`: es la autoridad de compras la que decide
 * que un faltante no representa trabajo. Un vendedor no ve ni el control.
 *
 * NO es un "OK" genérico. Descartar afirma que nadie va a pedir esto; marcar
 * como pedido afirma que ya se pidió. Un solo botón para ambos casos es el
 * error que obligó a revertir "OK gerencia", y no se repite.
 */
export async function discardMissingItemsAction(
  _prev: MissingItemActionState,
  formData: FormData,
): Promise<MissingItemActionState> {
  const session = await requireCapability("canOrderMissingItems");

  const parsed = discardMissingItemsSchema.safeParse({
    // `getAll`: los checkboxes del lote postean el mismo nombre repetido.
    ids: formData.getAll("ids").map(String),
    reason: formData.get("reason") ?? undefined,
  });

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Revisá la selección.";
    return { error: message, ok: false };
  }

  let result: Awaited<ReturnType<typeof discardMissingItems>>;
  try {
    result = await discardMissingItems({
      ids: parsed.data.ids,
      discardedById: session.user.id,
      reason: parsed.data.reason,
    });
  } catch (error) {
    console.error("[faltantes] No se pudieron descartar los faltantes:", error);
    return { error: "No se pudo descartar. Intentá de nuevo.", ok: false };
  }

  // Se audita UNA entrada por faltante descartado: el lote es una comodidad de
  // la pantalla, no una unidad de negocio. Quién descartó QUÉ es la pregunta
  // que alguien va a hacer cuando un faltante desaparezca de la cola.
  const context = await auditContextFromHeaders(session.user.id);
  for (const id of result.discarded) {
    await recordAudit({
      action: AUDIT_ACTIONS.MISSING_DISCARDED,
      module: AUDIT_MODULES.FALTANTES,
      entity: "MissingItem",
      entityId: id,
      after: { status: "CANCELADO", reason: parsed.data.reason ?? null },
      context,
    });
  }

  revalidatePath("/faltantes");
  revalidatePath("/dashboard");

  // Una carrera no es un error: otro gerente llegó primero. Se informa sin
  // pretender que el lote falló.
  if (result.discarded.length === 0) {
    return { error: "Ninguno de los faltantes elegidos seguía abierto.", ok: false };
  }
  return { error: null, ok: true };
}

/**
 * Pedido RÁPIDO de faltantes — el "chulito" de gerencia.
 *
 * Regla de negocio (reunión 2026-07-30): "yo marco los chulitos y ya lo que ya
 * pidió, un check que ya pidió y listo". Con 847 faltantes en cola y un flujo
 * de trabajo por laboratorio, exigir el formulario de proveedor + cantidad por
 * cada fila es lo que volvió la pantalla inusable.
 *
 * Sirve a UNA fila y a un lote de 80 con el mismo camino: el formulario de la
 * fila postea un solo `ids`, el de la selección postea muchos.
 *
 * Gateada con `canOrderMissingItems`, igual que el pedido completo y el
 * descarte: afirmar "ya lo compré" es autoridad de compras. Y NO es un alias
 * del descarte — marcar como pedido dice que la mercadería viene en camino;
 * descartar dice que nadie la va a pedir. Un botón ambiguo para las dos cosas
 * es el error que obligó a revertir "OK gerencia".
 */
export async function markMissingItemsOrderedAction(
  _prev: MissingItemActionState,
  formData: FormData,
): Promise<MissingItemActionState> {
  const session = await requireCapability("canOrderMissingItems");

  const parsed = markMissingItemsOrderedSchema.safeParse({
    // `getAll`: los checkboxes del lote postean el mismo nombre repetido.
    ids: formData.getAll("ids").map(String),
  });

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Revisá la selección.";
    return { error: message, ok: false };
  }

  let result: Awaited<ReturnType<typeof markMissingItemsOrdered>>;
  try {
    // El responsable sale SIEMPRE de la sesión: un `orderedById` inyectado en el
    // FormData no se lee, así que nadie firma un pedido a nombre de otro.
    result = await markMissingItemsOrdered({
      ids: parsed.data.ids,
      orderedById: session.user.id,
    });
  } catch (error) {
    console.error("[faltantes] No se pudieron marcar como pedidos:", error);
    return { error: "No se pudo marcar como pedido. Intentá de nuevo.", ok: false };
  }

  // A partir de acá el pedido YA está registrado. Auditoría y revalidación son
  // best-effort: si fallan, se registra el error pero NO se le dice al gerente
  // que falló, porque volvería a tocar el chulito sobre algo ya hecho. Mismo
  // criterio que `createMissingReportAction`. El try/catch cubre también
  // `auditContextFromHeaders`, que lee headers() y sí puede lanzar.
  try {
    const context = await auditContextFromHeaders(session.user.id);
    // Una entrada por faltante: el lote es una comodidad de la pantalla, no una
    // unidad de negocio. "¿Quién pidió esto?" es la pregunta que el gerente hizo
    // en voz alta durante la reunión.
    for (const id of result.ordered) {
      await recordAudit({
        action: AUDIT_ACTIONS.MISSING_ITEM_ORDERED,
        module: AUDIT_MODULES.FALTANTES,
        entity: "MissingItem",
        entityId: id,
        // Pedido rápido: sin proveedor ni cantidad todavía. Se deja explícito
        // para que la auditoría no aparente datos que nadie cargó.
        after: { status: "PEDIDO", supplierId: null, orderedQuantity: null },
        context,
      });
    }
  } catch (error) {
    console.error("[faltantes] Se marcó como pedido, pero no se pudo auditar:", error);
  }

  for (const path of ["/faltantes", "/dashboard"]) {
    try {
      revalidatePath(path);
    } catch (error) {
      console.error("[faltantes] Se marcó como pedido, pero no se pudo revalidar:", error);
    }
  }

  // Una carrera no es un error: otro gerente llegó primero, o la fila ya estaba
  // pedida. Se informa sin fingir que el lote falló.
  if (result.ordered.length === 0) {
    return { error: "Ninguno de los faltantes elegidos seguía abierto.", ok: false };
  }
  return { error: null, ok: true };
}

import type { PendingActionScope } from "@/lib/auth/permissions";
import type { PendingListItem } from "@/server/repositories/pending.repository";

// --------------------------------------------------------------------------
// Qué decirle al vendedor sobre la mercancía de su pendiente.
//
// Vive aparte de las listas porque LAS DOS lo necesitan: la vista Listado
// (compras) y la vista detallada, que es la que usa /revision-pendientes. Nació
// dentro de la primera, y por eso la segunda —la pantalla donde se revisa la
// cola— mostraba un pendiente ya cargado exactamente igual que uno que sigue
// esperando.
//
// Es una función pura sobre la fila: sin esto no se puede probar la regla sin
// renderizar una lista entera.
// --------------------------------------------------------------------------

export function isTerminal(item: PendingListItem): boolean {
  return (
    item.status === "ENTREGADO" ||
    item.status === "CANCELADO" ||
    // T2.2b: el cierre parcial es terminal. También lo cubre customerStatus
    // ENTREGADO, pero enumerarlo acá deja la regla explícita y a prueba de
    // futuros cambios en el eje comercial.
    item.status === "CLOSED_PARTIAL" ||
    item.customerStatus === "ENTREGADO" ||
    item.customerStatus === "CANCELADO"
  );
}

// Si la mercancía ya llegó a bodega, dicho con palabras y no solo con un color.
// Es independiente de lo facturable: una fila puede haber llegado y además estar
// lista para facturar, y entonces se dicen las dos cosas.
export function arrivalNotice(item: PendingListItem): string | null {
  if (isTerminal(item)) return null;
  if (item.availabilityStatus === "LLEGO_BODEGA" || item.availabilityStatus === "DISPONIBLE_COMPLETO") {
    return "Ya llegó a bodega";
  }
  if (item.availabilityStatus === "DISPONIBLE_PARCIAL") return "Ya llegó parte a bodega";
  return null;
}

// Cuánto de este pendiente ya está en bodega y todavía no se facturó, y cuánto
// se facturó y todavía no se entregó. Son las dos cifras que definen qué puede
// hacer el vendedor ahora mismo; el resto de la fila es contexto.
export function outstanding(item: PendingListItem): { toInvoice: number; toDeliver: number } {
  const invoiced = item.invoicedQuantity ?? 0;
  return {
    toInvoice: Math.max(item.quantity - invoiced, 0),
    toDeliver: Math.max(Math.min(invoiced, item.quantity) - item.deliveredQuantity, 0),
  };
}

/**
 * Cuánto de este pendiente se puede facturar AHORA: lo cargado que todavía no
 * se facturó, acotado a lo pedido. Cero en un pendiente terminal.
 *
 * Es LA regla de "listo para facturar", una sola vez: la usan el aviso, el botón
 * (`invoiceAffordance`), el color de la tarjeta y —traducida a Prisma en
 * `readyToInvoiceWhere`— el filtro "Listos para facturar" y su contador. Es la
 * MISMA cuenta que valida `invoicePending` en el servidor.
 *
 * No mira `customerStatus === "FACTURADO"` a propósito: `invoicePending` lo
 * escribe en CADA factura, también en la parcial, así que un pendiente
 * facturado a medias con carga nueva sigue teniendo algo que facturar.
 */
export function invoiceableQuantity(item: PendingListItem): number {
  if (isTerminal(item)) return 0;
  const invoiced = item.invoicedQuantity ?? 0;
  const ready = item.inventoryReadyQuantity ?? 0;
  return Math.max(Math.min(item.quantity - invoiced, ready - invoiced), 0);
}

/**
 * El color de estado de la tarjeta. La ACCIÓN posible manda:
 *
 *   "ready"    se puede facturar algo — gana aunque compras lo marcó AGOTADO.
 *   "soldOut"  no hay nada que facturar y está agotado (`purchaseStatus`, la
 *              columna viva; el AGOTADO de `status` es legado).
 *   null       ninguno de los dos, o el pendiente ya terminó.
 */
export function pendingStateTone(item: PendingListItem): "ready" | "soldOut" | null {
  if (invoiceableQuantity(item) > 0) return "ready";
  if (!isTerminal(item) && item.purchaseStatus === "AGOTADO") return "soldOut";
  return null;
}

/**
 * Quién está mirando la fila. Es lo que separa DOS preguntas que la pantalla
 * venía mezclando: si el pendiente está listo (un hecho de la mercadería) y si
 * esta persona puede facturarlo (un hecho de sus permisos).
 */
export type PendingViewer = {
  /** Alcance de facturación del rol autenticado. Ver `invoiceScopeFor`. */
  invoiceScope: PendingActionScope;
  /**
   * Alcance de contacto al cliente. Va SEPARADO del de facturación a propósito:
   * las pantallas los unían en un solo `canContactOrInvoice`, y con eso quien
   * podía llamar al cliente heredaba el botón de facturar sin que nadie lo
   * hubiera decidido.
   */
  contactScope: PendingActionScope;
  /** Id del usuario autenticado, único modo de resolver el alcance "own". */
  userId: string;
};

/** Si el alcance alcanza para operar ESTA fila. La regla de propiedad, una vez. */
function withinScope(
  item: PendingListItem,
  scope: PendingActionScope,
  userId: string,
): boolean {
  if (scope === "none") return false;
  if (scope === "all") return true;
  return item.createdBy?.id === userId;
}

/** Si a esta persona se le ofrece registrar el contacto con el cliente. */
export function canContactRow(item: PendingListItem, viewer: PendingViewer): boolean {
  if (isTerminal(item)) return false;
  return withinScope(item, viewer.contactScope, viewer.userId);
}

/**
 * Si a ESTA persona se le ofrece facturar ESTA fila, y por cuánto.
 *
 * Es la única fuente de esa decisión: la lista completa, la compacta y el aviso
 * de texto la llaman a ella. Antes cada superficie la resolvía por su cuenta con
 * un booleano plano de rol, y por eso podían contradecirse — que es exactamente
 * lo que pasó el 2026-10-04: la fila decía "Cargado · podés facturar" y abajo no
 * había botón.
 *
 * `invoiceable` sale de `invoiceableQuantity`, la MISMA cuenta que hace
 * `invoicePending` en el service. La pantalla no decide nada por su cuenta: solo
 * evita ofrecer un gesto que el servidor va a rechazar.
 */
export function invoiceAffordance(
  item: PendingListItem,
  viewer: PendingViewer,
): { canInvoice: boolean; invoiceable: number } {
  const invoiceable = invoiceableQuantity(item);

  if (isTerminal(item)) return { canInvoice: false, invoiceable: 0 };
  // Alcance acotado al dueño: BODEGA y OPERADOR ven filas ajenas —bodega por
  // `canReadAllPendings`— y sobre esas no se les ofrece facturar.
  if (!withinScope(item, viewer.invoiceScope, viewer.userId)) {
    return { canInvoice: false, invoiceable };
  }
  // Sin mercadería cargada no se ofrece el gesto: es la misma condición que el
  // service aplica, adelantada a la pantalla para no prometer un rechazo.
  return { canInvoice: invoiceable > 0, invoiceable };
}

/**
 * U5 — si a ESTA persona se le muestra el formulario de facturar aunque no haya
 * stock facturable: la excepción sin stock.
 *
 * Es aditiva a `invoiceAffordance` y NO la reemplaza: "listo para facturar"
 * (aviso, color, filtro y contador) sigue siendo `invoiceableQuantity`. Acá
 * solo se pregunta si queda saldo por facturar y si la fila está en el alcance
 * de quien mira. La segunda confirmación la pide el formulario, y el servidor
 * vuelve a decidir todo bajo el lock.
 */
export function canInvoiceWithoutStock(item: PendingListItem, viewer: PendingViewer): boolean {
  if (isTerminal(item)) return false;
  if (!withinScope(item, viewer.invoiceScope, viewer.userId)) return false;
  return outstanding(item).toInvoice > 0;
}

// El aviso que le faltaba al vendedor. Sin esto un pendiente se ve EXACTAMENTE
// igual antes y después de que su mercancía llegue a bodega: el sistema ya sabe
// que puede facturar, pero no se lo dice a nadie, y el cliente espera de más.
// Va como texto además de color porque estas filas se leen en un celular al sol.
//
// TODOS los avisos describen el PENDIENTE, nunca a quien lo lee. Son los
// peldaños de una sola escalera y se leen de corrido:
//
//   Sin stock  →  Llegó a la droguería · sin cargar
//              →  Listo para facturar  →  Listo para entregar
//
// Uno solo rompía esa forma: "Cargado · podés facturar" le hablaba al vendedor
// en segunda persona. Eran dos afirmaciones pegadas —llegó la mercadería, y vos
// podés facturarla— y solo la primera depende del pendiente. Por eso el aviso
// necesitaba saber QUIÉN estaba mirando la fila, para no prometerle facturar a
// quien no podía.
//
// Enunciado como estado desaparece el problema entero: "Listo para facturar" es
// cierto para el que puede facturar y para el que no. La función vuelve a ser
// pura sobre la fila. El BOTÓN sigue gateado por `invoiceAffordance`, que es
// donde la autoridad importa de verdad.
export function fulfillmentNotice(
  item: PendingListItem,
): { label: string; tone: "success" | "primary" | "warning" | "danger" } | null {
  if (isTerminal(item)) return null;

  // AMARILLO — hay algo que facturar AHORA. Va PRIMERO: es la acción posible, y
  // la regla es `invoiceableQuantity`, la misma del botón. Antes una llegada
  // parcial caía en el rojo de abajo mientras el botón sí facturaba, y un
  // pendiente facturado a medias no volvía nunca al amarillo.
  //
  // Mismo molde que "Listo para entregar", que es el peldaño siguiente: los dos
  // dicen qué se puede hacer con el pendiente, no qué puede hacer el lector.
  const invoiceable = invoiceableQuantity(item);
  if (invoiceable > 0) {
    return {
      label:
        invoiceable === item.quantity
          ? "Listo para facturar"
          : `Listo para facturar: ${invoiceable} de ${item.quantity}`,
      tone: "warning",
    };
  }

  const available = item.inventoryReadyQuantity ?? 0;
  const remaining = item.quantity - item.deliveredQuantity - item.cancelledQuantity;
  const readyForRemaining = Math.max(available - item.deliveredQuantity, 0);
  const notInvoiced = item.customerStatus !== "FACTURADO";

  if (remaining > 0 && readyForRemaining === 0) {
    return { label: "Sin stock", tone: "danger" };
  }

  if (readyForRemaining > 0 && readyForRemaining < remaining) {
    return {
      label: `Sin stock suficiente · ${readyForRemaining} de ${remaining} restantes disponibles`,
      tone: "danger",
    };
  }

  // VERDE — llegó a la droguería pero todavía no está cargado. El vendedor ya
  // puede avisarle al cliente; facturarlo todavía no.
  if (notInvoiced && item.availabilityStatus === "LLEGO_BODEGA") {
    return { label: "Llegó a la droguería · sin cargar", tone: "success" };
  }

  // Sin repetir "Facturado": la insignia de estado, justo al lado, ya lo dice.
  // Repetirlo alargaba la frase y la partía en tres líneas dentro de una
  // columna angosta, sin agregar ninguna información.
  if (outstanding(item).toDeliver > 0) {
    return { label: "Listo para entregar", tone: "primary" };
  }
  return null;
}

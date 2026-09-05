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
 * `invoiceable` es la MISMA cuenta que hace `invoicePending` en el service. La
 * pantalla no decide nada por su cuenta: solo evita ofrecer un gesto que el
 * servidor va a rechazar.
 */
export function invoiceAffordance(
  item: PendingListItem,
  viewer: PendingViewer,
): { canInvoice: boolean; invoiceable: number } {
  const invoiced = item.invoicedQuantity ?? 0;
  const ready = item.inventoryReadyQuantity ?? 0;
  const invoiceable = Math.max(
    Math.min(item.quantity - invoiced, ready - invoiced),
    0,
  );

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

// El aviso que le faltaba al vendedor. Sin esto un pendiente se ve EXACTAMENTE
// igual antes y después de que su mercancía llegue a bodega: el sistema ya sabe
// que puede facturar, pero no se lo dice a nadie, y el cliente espera de más.
// Va como texto además de color porque estas filas se leen en un celular al sol.
//
// El aviso NO promete lo que el lector no puede hacer. "Cargado · podés
// facturar" es dos afirmaciones pegadas —llegó la mercadería, y vos podés
// facturarla— y solo la primera depende del pendiente. A quien no tiene la
// autoridad se le dice "Cargado" y nada más: el hecho, sin la promesa.
export function fulfillmentNotice(
  item: PendingListItem,
  viewer: PendingViewer,
): { label: string; tone: "success" | "primary" | "warning" | "danger" } | null {
  if (isTerminal(item)) return null;

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

  // AMARILLO — bodega ya lo subió al sistema. Es el aviso que espera el
  // vendedor: "ya te llegó, te lo vamos a mandar".
  if (notInvoiced && available > 0) {
    const parcial = available < item.quantity;
    const cargado = parcial ? `Cargado: ${available} de ${item.quantity}` : "Cargado";
    // La invitación a facturar solo se agrega si esta persona efectivamente
    // puede: para el resto el hecho se enuncia y ahí termina.
    const invitacion = invoiceAffordance(item, viewer).canInvoice ? " · podés facturar" : "";
    return { label: `${cargado}${invitacion}`, tone: "warning" };
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

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

// El aviso que le faltaba al vendedor. Sin esto un pendiente se ve EXACTAMENTE
// igual antes y después de que su mercancía llegue a bodega: el sistema ya sabe
// que puede facturar, pero no se lo dice a nadie, y el cliente espera de más.
// Va como texto además de color porque estas filas se leen en un celular al sol.
export function fulfillmentNotice(
  item: PendingListItem,
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
    return {
      label:
        available < item.quantity
          ? `Cargado: ${available} de ${item.quantity} · podés facturar`
          : "Cargado · podés facturar",
      tone: "warning",
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

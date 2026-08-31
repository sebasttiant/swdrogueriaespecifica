import type { PendingIdentityDeferral } from "@/lib/generated/prisma/client";

// --------------------------------------------------------------------------
// El aviso de "identidad pendiente" sobre un pendiente aplazado (S2b · 1e-E).
//
// DERIVADO, nunca guardado. No hay columna `warn`, no hay booleano `healed`, y
// esa es toda la idea: en cuanto alguien le carga el código de Orion al
// producto, los seis pendientes que lo esperaban dejan de avisar solos. Sin
// backfill, sin job de limpieza, y sin la posibilidad de que quede una alerta
// vieja encendida sobre algo que ya se resolvió —que es exactamente lo que
// pasa con los flags que hay que apagar a mano.
//
// Lo que NO se apaga es el motivo. El aplazamiento es historia operativa
// permanente (D9): sirve para medir cuánto estorba la exigencia y cuántas
// veces se cae Orion. Esta función solo LEE; no toca ni el motivo ni la nota.
//
// Vive aparte de las listas porque las dos la necesitan, y una regla así
// nacida adentro de una lista termina distinta en la otra: ya pasó con
// `fulfillmentNotice`, y la vista de revisión estuvo mostrando un pendiente ya
// cargado igual que uno que seguía esperando.
// --------------------------------------------------------------------------

/**
 * Lo ÚNICO que decide el aviso.
 *
 * Se declara angosto a propósito, en vez de pedir un `PendingListItem`
 * entero: así la regla dice de qué depende de verdad, se prueba con dos
 * campos en vez de una fila completa, y cualquier vista que tenga estos dos
 * datos puede consultarla sin arrastrar el contrato del listado.
 */
export type PendingIdentityView = {
  identitySkippedReason: PendingIdentityDeferral | null;
  product: { orionCode: string | null };
};

/**
 * Se nombra el estado del PRODUCTO, no el del pendiente: lo que falta es el
 * código, y quien lea esto tiene que saber qué ir a buscar.
 *
 * Dice "Sin SKU" y no "Identidad pendiente" porque nombra la FALTA concreta y
 * con las palabras que se usan en el mostrador. "Identidad pendiente" describía
 * un estado del sistema —correcto, pero ilegible para quien tiene que ir a
 * Orion a buscar el código—, y encima se confundía con el estado "Pendiente"
 * del propio pedido, que es otra cosa. El paréntesis nombra el campo tal como
 * aparece en el formulario de captura.
 */
export const IDENTITY_WARNING_LABEL = "Sin SKU (Sin Código de Orión)";

/**
 * El aviso, o `null` cuando no hay nada que avisar.
 *
 * Devuelve la etiqueta y no un booleano para que sea imposible pintar el
 * cartel sin haber consultado la regla.
 */
export function identityWarning(item: PendingIdentityView): string | null {
  // Sin motivo no hubo aplazamiento. Acá caen los pendientes anteriores a S2b
  // y los que se capturaron con su código: un producto sin código NO es un
  // aplazamiento, y tratarlo como tal inventaría una historia que no ocurrió
  // sobre los ~151 productos legados.
  if (item.identitySkippedReason == null) return null;
  // Ya tiene identidad: el aviso se apagó solo. El motivo sigue guardado.
  if (item.product.orionCode != null) return null;
  return IDENTITY_WARNING_LABEL;
}

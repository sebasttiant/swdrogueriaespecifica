// --------------------------------------------------------------------------
// La PRESENTACIÓN de un producto: frasco, sobre, caja, blíster, ampolla.
//
// Una sola definición, por el mismo motivo que `identity-warning` y
// `fulfillmentNotice` viven aparte: la necesitan el formulario de Pendientes,
// las dos vistas de la lista compacta y el detalle de Revisión. Una regla así
// nacida adentro de una lista termina distinta en la otra —ya pasó— y entonces
// la misma fila dice dos cosas según dónde se la mire.
//
// SE CAPTURA EN PENDIENTES Y SE CONSULTA EN TODO EL RESTO DEL PROCESO. Ninguna
// pantalla de revisión la edita: el catálogo es información compartida y un
// vendedor no puede alterarla desde una pantalla de captura. Por eso acá no hay
// ninguna función de escritura, ni la va a haber.
//
// De dónde sale el dato, para los DOS orígenes:
//
//   producto del catálogo  ->  `product.unit`, tal como está guardado.
//   producto manual/nuevo  ->  también `product.unit`: lo que el vendedor
//                              escribió en `manualUnit` se guarda en el
//                              producto al crearlo (ver `schema.ts`, donde
//                              `unit: data.manualUnit ?? MANUAL_UNIT_FALLBACK`).
//
// Es decir: una sola fuente para los dos casos, sin columna nueva y sin
// migración. Quien lee esto y espera encontrar dos caminos, no los hay.
// --------------------------------------------------------------------------

/**
 * Lo que se muestra cuando el producto no tiene presentación cargada.
 *
 * Se dice explícitamente en vez de dejar el lugar en blanco: un espacio vacío
 * no distingue "no tiene" de "no se cargó la pantalla", y quien decide una
 * compra necesita esa diferencia.
 */
export const NO_PRESENTATION_LABEL = "Sin presentación";

/** El rótulo con el que se nombra el dato en TODAS las pantallas. */
export const PRESENTATION_LABEL = "Presentación";

/**
 * La presentación lista para mostrar, o `NO_PRESENTATION_LABEL`.
 *
 * `unit` es `String` no nulo en el esquema, pero llega vacío o con solo
 * espacios en productos legados y en los manuales que nadie completó. Los tres
 * casos son "no tiene presentación" para quien mira la pantalla.
 */
export function presentationLabel(unit: string | null | undefined): string {
  const trimmed = unit?.trim();
  return trimmed ? trimmed : NO_PRESENTATION_LABEL;
}

/**
 * `true` cuando el producto tiene una presentación de verdad.
 *
 * Sirve para decidir tono o énfasis sin repetir la comparación contra la
 * etiqueta de "sin presentación", que es texto de pantalla y no un valor.
 */
export function hasPresentation(unit: string | null | undefined): boolean {
  return Boolean(unit?.trim());
}

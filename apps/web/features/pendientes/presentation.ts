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
 * Lo que se guarda en `product.unit` cuando el vendedor NO escribe una
 * presentación al cargar un producto manual.
 *
 * Es un relleno técnico, no un dato: la columna es `String` no nulo, así que
 * algo hay que escribir. Vive acá —y no en el esquema de validación— porque
 * quien lo lee es la pantalla, y porque la regla de "esto no es información"
 * tiene que estar en el mismo archivo que la decide.
 */
export const MANUAL_UNIT_FALLBACK = "unidad";

/**
 * La presentación lista para mostrar, o `NO_PRESENTATION_LABEL`.
 *
 * Tres casos son "no tiene presentación" para quien mira la pantalla:
 *
 *   vacío o espacios  -> productos legados y manuales sin completar.
 *   `MANUAL_UNIT_FALLBACK` -> el relleno que escribe el formulario cuando el
 *                        vendedor deja el campo en blanco.
 *
 * El tercero es el que importa. Ese "unidad" no lo escribió nadie: lo puso el
 * sistema para poder guardar la fila. Mostrarlo como presentación es presentar
 * un relleno como si fuera un dato, y quien lee la pantalla no tiene forma de
 * distinguirlo de una presentación de verdad — decide una compra creyendo que
 * alguien la registró.
 *
 * EL PRECIO, dicho de frente: un producto cuya presentación real sea
 * literalmente "unidad" va a leerse como "Sin presentación". Se acepta porque
 * en una droguería las presentaciones son frasco, sobre, caja, blíster o
 * ampolla; "unidad" es la ausencia de una presentación especial, no una. Si
 * algún día hace falta distinguirlas de verdad, eso pide una columna propia y
 * su migración, no una comparación de textos.
 */
export function presentationLabel(unit: string | null | undefined): string {
  const trimmed = unit?.trim();
  if (!trimmed) return NO_PRESENTATION_LABEL;
  if (trimmed.toLowerCase() === MANUAL_UNIT_FALLBACK) return NO_PRESENTATION_LABEL;
  return trimmed;
}

/**
 * `true` cuando el producto tiene una presentación de verdad.
 *
 * Sirve para decidir tono o énfasis sin repetir la comparación contra la
 * etiqueta de "sin presentación", que es texto de pantalla y no un valor.
 */
export function hasPresentation(unit: string | null | undefined): boolean {
  // Se compara contra las ENTRADAS que significan ausencia, no contra la
  // etiqueta de salida. Delegar en `presentationLabel` parecía más corto y
  // metía un defecto: un producto cuya unidad fuera literalmente "Sin
  // presentación" —texto de pantalla, no un valor— se habría contado como si
  // no tuviera ninguna.
  const trimmed = unit?.trim();
  if (!trimmed) return false;
  return trimmed.toLowerCase() !== MANUAL_UNIT_FALLBACK;
}

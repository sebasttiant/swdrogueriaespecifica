// --------------------------------------------------------------------------
// El enlace a UN pendiente concreto, y el ancla a la que llega.
//
// Los dos salen de acá porque el defecto que esto arregla fue exactamente que
// no lo hacían. El aviso de llegada enlazaba a
// `/pendientes?view=listado#pendiente-<id>` y esa dirección tenía tres cosas
// mal a la vez:
//
//   1. El ancla `#pendiente-<id>` NO EXISTÍA. Ningún componente escribía ese
//      `id`. El navegador buscaba un destino inexistente y se quedaba arriba de
//      todo, que es donde está el formulario de "Nuevo pendiente": el vendedor
//      hacía clic en "ver el que llegó" y le aparecía la pantalla de cargar uno
//      nuevo.
//   2. `view=listado` no es un valor válido —los que existen son `lista` y
//      `detalle`—, así que caía en el default por casualidad.
//   3. Iba a `/pendientes`, que es la pantalla de CAPTURA. Lo que el vendedor
//      necesita cuando le avisan que llegó la mercadería es el pendiente en la
//      mesa de trabajo, con el botón de facturar al lado.
//
// Mientras el `href` y el `id` vivan en archivos distintos, esto vuelve a
// pasar: nadie se entera de que un ancla dejó de existir. Acá el enlace no se
// puede construir sin la función que también nombra el destino.
//
// PURO: sin Prisma, sin reloj, sin React. Se prueba con un string.
// --------------------------------------------------------------------------

/** La pantalla donde se OPERA un pendiente, no donde se carga uno nuevo. */
const REVIEW_PATH = "/revision-pendientes";

/**
 * El `id` del elemento que representa al pendiente en una lista.
 *
 * Lo escriben las listas en cada fila; `pendingReviewHref` apunta acá. Cambiar
 * el formato en un solo lado es imposible: es la misma función.
 */
export function pendingAnchorId(pendingId: string): string {
  return `pendiente-${pendingId}`;
}

/**
 * El parámetro que le dice al SERVIDOR qué fila hay que garantizar en la página.
 *
 * Existe por un detalle de HTTP que decide todo el diseño: el fragmento de una
 * URL —el `#loquesea`— NUNCA se envía al servidor. Lo resuelve el navegador,
 * solo, sobre el HTML que ya recibió.
 *
 * Con la lista paginada de a 20, eso significa que un ancla alcanza únicamente
 * si el pendiente cayó en la primera página. Para uno más viejo, el servidor no
 * tiene forma de saber que hacía falta —el `#` no le llegó—, no lo renderiza, y
 * el enlace vuelve a no hacer nada. El mismo síntoma de siempre, reapareciendo
 * solo con los pedidos que ya bajaron en la cola.
 *
 * Por eso el id viaja DOS veces: en la query, que sí llega al servidor y le
 * permite traer esa fila; y en el fragmento, que es lo que hace saltar al
 * navegador una vez que la fila está en el DOM.
 */
export const FOCUS_PARAM = "focus";

/**
 * Enlace a un pendiente concreto dentro de Revisión de pendientes.
 *
 * Sin `?tab=`: `resolveReviewTab` manda a "seguimiento" por defecto, que es la
 * mitad donde vive la lista de pendientes. Agregar el parámetro sería repetir
 * un default que ya está definido en un solo lugar.
 */
export function pendingReviewHref(pendingId: string): string {
  const query = new URLSearchParams({ [FOCUS_PARAM]: pendingId });
  return `${REVIEW_PATH}?${query.toString()}#${pendingAnchorId(pendingId)}`;
}

/**
 * Lee el `?focus=` de la URL.
 *
 * Es input de usuario y termina en una consulta: se acepta solo un id con la
 * forma que genera la aplicación (cuid), y cualquier otra cosa se descarta. El
 * recorte por dueño manda igual del lado del servicio; esto es la primera
 * puerta, no la única.
 */
export function resolveFocusedPendingId(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return /^[a-z0-9]{20,40}$/i.test(trimmed) ? trimmed : null;
}

/**
 * Enlace a Revisión de pendientes sin señalar ninguna fila.
 *
 * Lo usa la barra de avisos, que cuenta pedidos pero no nombra cuál: su único
 * trabajo es sacarte de donde estás.
 */
export function pendingReviewListHref(): string {
  return REVIEW_PATH;
}

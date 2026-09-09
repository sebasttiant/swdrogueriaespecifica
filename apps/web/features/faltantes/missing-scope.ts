// --------------------------------------------------------------------------
// Vistas de la cola de faltantes, por ESTADO del faltante.
//
// Regla de negocio (reunión 2026-07-30): "cuando ellos le pongan el okay, que
// desaparezca de la lista... que ahí nada más aparezca lo que está en blanco".
// Lo pedido y lo descartado NO se borran: se mudan a su propia vista.
//
// Viaja en la URL, server-rendered, sin estado de cliente y con URL
// compartible —mismo criterio que el scope de pendientes—.
//
// La vista compacta (y su toggle Completa/Compacta) se retiró: el dueño
// comparó las dos listas contra datos de producción y convergían, así que
// queda UNA sola (`MissingList`). Este archivo ya no arrastra ningún
// parámetro de layout: solo el scope y la selección masiva.
// --------------------------------------------------------------------------

import type { MissingItemScope } from "@/server/repositories/missing-item.repository";

export const MISSING_SCOPES = ["actionable", "ordered", "discarded"] as const;

export type MissingQueueScope = (typeof MISSING_SCOPES)[number];

// Las etiquetas hablan el idioma de la droguería, no el del modelo de datos.
// Quien las lee es un gerente de 60 años desde el celular: "Por pedir" le dice
// qué tiene que hacer; "actionable" no le dice nada.
export const MISSING_SCOPE_LABELS: Record<MissingQueueScope, string> = {
  actionable: "Por pedir",
  ordered: "Ya pedidos",
  discarded: "Descartados",
};

// El scope de la cola mapea 1:1 con el del repositorio. Se declara explícito
// —en vez de castear— para que agregar una vista futura sin su filtro sea un
// error de tipos y no una consulta que devuelve cualquier cosa.
const REPOSITORY_SCOPE: Record<MissingQueueScope, MissingItemScope> = {
  actionable: "actionable",
  ordered: "ordered",
  discarded: "discarded",
};

/**
 * Resuelve el `?scope=` de la URL. Cualquier valor desconocido cae en la cola
 * de trabajo: el parámetro es input del usuario y no puede romper la página ni
 * abrir una vista que no existe.
 *
 * El default es `actionable` a propósito: lo primero que ve el gerente al
 * entrar es lo que TIENE QUE HACER.
 */
export function resolveMissingScope(param?: string | null): MissingQueueScope {
  return MISSING_SCOPES.includes(param as MissingQueueScope)
    ? (param as MissingQueueScope)
    : "actionable";
}

export function repositoryScopeFor(scope: MissingQueueScope): MissingItemScope {
  return REPOSITORY_SCOPE[scope];
}

// --------------------------------------------------------------------------
// Dónde vive un tablero y CÓMO se llaman sus parámetros en la URL.
//
// La misma cola operativa se muestra en DOS pantallas —reposición de
// estantería en Revisión de faltantes, pedidos de cliente en Revisión de
// pendientes— y cada una arma sus enlaces sobre su propia ruta. Una constante
// fija acá haría que tocar una pestaña te sacara de la pantalla en la que
// estás trabajando; ese bug ya apareció una vez, en la mudanza a Revisión.
//
// Los NOMBRES de los parámetros también viajan acá, y no es decoración.
// Revisión de pendientes ya usa `scope` y `cursor` para su propia lista de
// pendientes. Si el tablero de abastecimiento reusara esos nombres, los dos se
// pisarían en la misma URL: cambiar de pestaña en uno movería el otro. Ya pasó
// con el buzón de reportes, que terminó necesitando `rscope`. Declararlos en
// la ruta hace la colisión IMPOSIBLE por construcción, en vez de dejarla
// dependiendo de que alguien se acuerde.
// --------------------------------------------------------------------------
export type MissingBoardRoute = {
  basePath: string;
  scopeParam: string;
  cursorParam: string;
  /**
   * Selección masiva: modo alternativo de la lista real (checkbox por fila +
   * barra de acciones en lote), activado por este parámetro. Mismo motivo que
   * `scopeParam`/`cursorParam`: Revisión de pendientes monta DOS listas, y un
   * nombre compartido las pisaría en la misma URL.
   */
  bulkParam: string;
  /**
   * Lo que TODO enlace de este tablero tiene que arrastrar: sin esto, tocar
   * una pestaña dentro de una sub-pantalla te devuelve a la de arriba.
   */
  persistentParams?: Readonly<Record<string, string>>;
};

/** Dónde vive la cola de faltantes de ESTANTERÍA. */
export const MISSING_QUEUE_PATH = "/revision-faltantes";

/** Dónde vive el abastecimiento de los pedidos de CLIENTE. */
export const PENDING_SUPPLY_PATH = "/revision-pendientes";

/** Valor de `?tab=` que abre el abastecimiento en Revisión de pendientes. */
export const SUPPLY_TAB = "abastecimiento";

export const SHELF_BOARD_ROUTE: MissingBoardRoute = {
  basePath: MISSING_QUEUE_PATH,
  scopeParam: "scope",
  cursorParam: "cursor",
  bulkParam: "bulk",
};

export const PENDING_SUPPLY_ROUTE: MissingBoardRoute = {
  basePath: PENDING_SUPPLY_PATH,
  // Prefijo `s` de "suministro": estos nombres NO pueden ser `scope`, `cursor`
  // ni `bulk`, que ya son (o pueden ser) de la lista de pendientes de esa
  // pantalla.
  scopeParam: "sscope",
  cursorParam: "scursor",
  bulkParam: "sbulk",
  persistentParams: { tab: SUPPLY_TAB },
};

function missingHref(
  route: MissingBoardRoute,
  scope: MissingQueueScope,
  cursor?: string,
  bulk?: boolean,
): string {
  const params = new URLSearchParams(route.persistentParams);
  if (scope !== "actionable") params.set(route.scopeParam, scope);
  if (cursor) params.set(route.cursorParam, cursor);
  // Se escribe el valor NO predeterminado: el default de `resolveMissingBulkMode`
  // es "modo normal", así que solo se escribe cuando el modo está activo.
  if (bulk) params.set(route.bulkParam, "1");
  const query = params.toString();
  return query ? `${route.basePath}?${query}` : route.basePath;
}

/** URL de una vista, preservando la selección masiva. El cursor NO se
 *  preserva: cambiar de scope empieza en su primera página, o el cursor
 *  apuntaría a una fila que ese scope no contiene. */
export function missingScopeHref(
  scope: MissingQueueScope,
  route: MissingBoardRoute = SHELF_BOARD_ROUTE,
  bulk = false,
): string {
  return missingHref(route, scope, undefined, bulk);
}

/** URL de la página SIGUIENTE, preservando scope y selección masiva. Sin esto,
 *  "Ver más" devolvía a la cola por defecto: en un celular con cientos de
 *  faltantes, eso es perder el lugar donde uno estaba. */
export function missingPageHref(
  scope: MissingQueueScope,
  cursor: string,
  route: MissingBoardRoute = SHELF_BOARD_ROUTE,
  bulk = false,
): string {
  return missingHref(route, scope, cursor, bulk);
}

// --------------------------------------------------------------------------
// Selección masiva: modo alternativo de la MISMA lista (checkbox por fila +
// barra de acciones en lote), activado por `?bulk=1` (o `?sbulk=1` en
// Revisión de pendientes — ver `MissingBoardRoute.bulkParam`). Viaja en la
// URL por la misma razón que el scope: server-rendered, sin estado de
// cliente, compartible. Vivía en `missing-view.ts` junto al toggle de layout
// que se retiró; este parámetro SÍ sobrevive, así que se muda acá.
//
// Solo el valor exacto "1" activa el modo. Es input de usuario: cualquier
// otra cosa (ausente, basura, otro string) tiene que caer en modo normal, o
// una URL manipulada a mano podría dejar la pantalla en un estado que nadie
// pidió.
// --------------------------------------------------------------------------
export function resolveMissingBulkMode(param?: string | null): boolean {
  return param === "1";
}

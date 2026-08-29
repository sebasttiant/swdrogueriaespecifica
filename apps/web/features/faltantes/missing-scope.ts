// --------------------------------------------------------------------------
// Vistas de la cola de faltantes, por ESTADO del faltante.
//
// Eje DISTINTO de `missing-view.ts`, que decide el LAYOUT (completa/compacta).
// Se pueden combinar: ?scope=ordered&view=compact.
//
// Regla de negocio (reunión 2026-07-30): "cuando ellos le pongan el okay, que
// desaparezca de la lista... que ahí nada más aparezca lo que está en blanco".
// Lo pedido y lo descartado NO se borran: se mudan a su propia vista.
//
// Viaja en la URL, server-rendered, sin estado de cliente y con URL compartible
// —mismo criterio que el toggle de layout y que el scope de pendientes—.
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
// Revisión de pendientes ya usa `scope`, `view` y `cursor` para su propia
// lista de pendientes. Si el tablero de abastecimiento reusara esos nombres,
// los dos se pisarían en la misma URL: cambiar de pestaña en uno movería el
// otro. Ya pasó con el buzón de reportes, que terminó necesitando `rscope`.
// Declararlos en la ruta hace la colisión IMPOSIBLE por construcción, en vez
// de dejarla dependiendo de que alguien se acuerde.
// --------------------------------------------------------------------------
export type MissingBoardRoute = {
  basePath: string;
  scopeParam: string;
  viewParam: string;
  cursorParam: string;
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
  viewParam: "view",
  cursorParam: "cursor",
};

export const PENDING_SUPPLY_ROUTE: MissingBoardRoute = {
  basePath: PENDING_SUPPLY_PATH,
  // Prefijo `s` de "suministro": estos tres nombres NO pueden ser `scope`,
  // `view` ni `cursor`, que ya son de la lista de pendientes de esa pantalla.
  scopeParam: "sscope",
  viewParam: "sview",
  cursorParam: "scursor",
  persistentParams: { tab: SUPPLY_TAB },
};

function missingHref(
  route: MissingBoardRoute,
  scope: MissingQueueScope,
  view: "full" | "compact",
  cursor?: string,
): string {
  const params = new URLSearchParams(route.persistentParams);
  if (scope !== "actionable") params.set(route.scopeParam, scope);
  // Se escribe el valor NO predeterminado, y el predeterminado es `compact`
  // —lo fija `resolveMissingView`—. Estaba al revés: el enlace de "Completa"
  // omitía el parámetro, la URL quedaba sin `view`, y el resolvedor la leía
  // como compacta. El botón era literalmente imposible de activar: se hacía
  // clic, la URL cambiaba de scope y la vista seguía siendo la misma.
  if (view === "full") params.set(route.viewParam, "full");
  if (cursor) params.set(route.cursorParam, cursor);
  const query = params.toString();
  return query ? `${route.basePath}?${query}` : route.basePath;
}

/** URL de una vista, preservando el layout elegido. El cursor NO se preserva:
 *  cambiar de vista empieza en su primera página, o el cursor apuntaría a una
 *  fila que esa vista no contiene. */
export function missingScopeHref(
  scope: MissingQueueScope,
  view: "full" | "compact",
  route: MissingBoardRoute = SHELF_BOARD_ROUTE,
): string {
  return missingHref(route, scope, view);
}

/** URL de la página SIGUIENTE, preservando vista y layout. Sin esto, "Ver más"
 *  devolvía a la cola por defecto y en formato completo: en un celular con
 *  cientos de faltantes, eso es perder el lugar donde uno estaba. */
export function missingPageHref(
  scope: MissingQueueScope,
  view: "full" | "compact",
  cursor: string,
  route: MissingBoardRoute = SHELF_BOARD_ROUTE,
): string {
  return missingHref(route, scope, view, cursor);
}

// Qué decir cuando una vista no tiene nada. Un mensaje genérico ("no hay
// faltantes abiertos") dentro de "Descartados" hace dudar de si la acción se
// guardó, que es exactamente la duda que no queremos sembrar.
export const MISSING_SCOPE_EMPTY: Record<
  MissingQueueScope,
  { title: string; description: string }
> = {
  actionable: {
    title: "Nada por pedir",
    description: "No queda ningún faltante esperando decisión.",
  },
  ordered: {
    title: "Todavía no pediste nada",
    description: "Lo que marques como pedido aparece acá.",
  },
  discarded: {
    title: "Nada descartado",
    description: "Lo que descartes aparece acá; no se borra.",
  },
};

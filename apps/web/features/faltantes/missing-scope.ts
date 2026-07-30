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

function missingHref(
  scope: MissingQueueScope,
  view: "full" | "compact",
  cursor?: string,
): string {
  const params = new URLSearchParams();
  if (scope !== "actionable") params.set("scope", scope);
  if (view === "compact") params.set("view", "compact");
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return query ? `/faltantes?${query}` : "/faltantes";
}

/** URL de una vista, preservando el layout elegido. El cursor NO se preserva:
 *  cambiar de vista empieza en su primera página, o el cursor apuntaría a una
 *  fila que esa vista no contiene. */
export function missingScopeHref(
  scope: MissingQueueScope,
  view: "full" | "compact",
): string {
  return missingHref(scope, view);
}

/** URL de la página SIGUIENTE, preservando vista y layout. Sin esto, "Ver más"
 *  devolvía a la cola por defecto y en formato completo: en un celular con
 *  cientos de faltantes, eso es perder el lugar donde uno estaba. */
export function missingPageHref(
  scope: MissingQueueScope,
  view: "full" | "compact",
  cursor: string,
): string {
  return missingHref(scope, view, cursor);
}

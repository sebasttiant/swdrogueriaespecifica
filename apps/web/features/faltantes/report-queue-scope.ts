// --------------------------------------------------------------------------
// Vistas de la cola de revisión de faltantes.
//
// Las MISMAS tres que /faltantes, con las mismas palabras. Que las dos
// pantallas se comporten idéntico es lo que permite que don Guillermo aprenda
// un solo gesto: entra, ve lo que falta por decidir, marca, y si necesita
// consultar lo resuelto está al lado.
//
// Viaja en la URL, server-rendered, sin estado de cliente.
// --------------------------------------------------------------------------

export const REPORT_QUEUE_SCOPES = ["pending", "ordered", "arrived", "discarded"] as const;

export type ReportQueueScope = (typeof REPORT_QUEUE_SCOPES)[number];

// Mismas etiquetas que las pestañas de /faltantes, a propósito.
export const REPORT_QUEUE_SCOPE_LABELS: Record<ReportQueueScope, string> = {
  pending: "Por pedir",
  ordered: "Ya pedidos",
  arrived: "En bodega",
  discarded: "Descartados",
};

// Qué decir cuando una vista está vacía. Un mensaje genérico haría dudar de si
// la acción se guardó, que es justo la duda que no queremos sembrar.
export const REPORT_QUEUE_SCOPE_EMPTY: Record<
  ReportQueueScope,
  { title: string; description: string }
> = {
  pending: {
    title: "No hay reportes pendientes",
    description: "Cuando un vendedor reporte un faltante, aparece acá.",
  },
  ordered: {
    title: "Todavía no pediste nada",
    description: "Lo que marques como pedido aparece acá.",
  },
  arrived: {
    title: "Nada esperando carga",
    description: "Lo que llegue físicamente aparece acá hasta que bodega cargue la entrada.",
  },
  discarded: {
    title: "Nada descartado",
    description: "Lo que descartes aparece acá; no se borra.",
  },
};

/**
 * Resuelve el `?scope=` de la URL. Cualquier valor desconocido cae en la cola
 * de trabajo: el parámetro es input del usuario y no puede romper la página.
 */
export function resolveReportQueueScope(param?: string | null): ReportQueueScope {
  return REPORT_QUEUE_SCOPES.includes(param as ReportQueueScope)
    ? (param as ReportQueueScope)
    : "pending";
}

/** URL de una vista. El número de página NO se preserva al cambiar de pestaña:
 *  la página 3 de "por pedir" no existe necesariamente en "descartados". */
export function reportQueueScopeHref(scope: ReportQueueScope): string {
  return scope === "pending"
    ? "/revision-faltantes"
    : `/revision-faltantes?scope=${scope}`;
}

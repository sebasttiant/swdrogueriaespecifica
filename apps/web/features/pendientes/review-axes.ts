// --------------------------------------------------------------------------
// Ejes de revisión de pendientes (T4.2).
//
// Un pendiente vive en tres ejes INDEPENDIENTES, y la revisión los filtra por
// separado porque responden preguntas distintas:
//
//   compras        ¿en qué punto está conseguir el producto?
//   disponibilidad ¿dónde está físicamente lo que se prometió?
//   cliente        ¿en qué punto está la relación con quien lo espera?
//
// Un pendiente puede estar SOLICITADO al proveedor, LLEGO_BODEGA a medias y con
// el cliente todavía POR_CONTACTAR. Meterlos en un solo estado obligaría a
// inventar combinaciones; por eso son ejes y por eso se filtran juntos con Y.
//
// PURO: no toca Prisma ni el reloj. La página lo usa para leer la URL y el
// componente de filtros para pintarse. Nunca importar Prisma acá.
// --------------------------------------------------------------------------

import { MANAGEMENT_STATUSES, MANAGEMENT_STATUS_LABELS } from "./management-status";

export const PURCHASE_AXIS_VALUES = ["POR_PEDIR", ...MANAGEMENT_STATUSES] as const;
export const AVAILABILITY_AXIS_VALUES = [
  "ESPERANDO",
  "LLEGO_BODEGA",
  "DISPONIBLE_PARCIAL",
  "DISPONIBLE_COMPLETO",
] as const;
export const CUSTOMER_AXIS_VALUES = [
  "POR_CONTACTAR",
  "CONTACTADO",
  "FACTURADO",
  "ENTREGADO",
  "CANCELADO",
] as const;

// La ventana de ENTREGA. No es una columna de estado como los otros tres: es
// una comparación contra el reloj (`deadlineWhere` en el repositorio).
//
// Las palabras son las MISMAS que dicen los chips de la barra de alertas
// —"Atrasadas", "Próximas"—. Que el chip, la URL y el filtro se llamen igual es
// lo que hace que tocar el aviso y ver la lista se sienta un solo gesto.
export const DEADLINE_AXIS_VALUES = ["atrasadas", "proximas"] as const;

export type PurchaseAxis = (typeof PURCHASE_AXIS_VALUES)[number];
export type DeadlineAxis = (typeof DEADLINE_AXIS_VALUES)[number];
export type AvailabilityAxis = (typeof AVAILABILITY_AXIS_VALUES)[number];
export type CustomerAxis = (typeof CUSTOMER_AXIS_VALUES)[number];

export type ReviewAxes = {
  purchase?: PurchaseAxis;
  availability?: AvailabilityAxis;
  customer?: CustomerAxis;
  deadline?: DeadlineAxis;
};

// Las etiquetas de gestión son las mismas que ya ve el vendedor en la fila: el
// filtro tiene que decir lo mismo que la lista, o parecen dos cosas distintas.
export const PURCHASE_AXIS_LABELS: Record<PurchaseAxis, string> = {
  POR_PEDIR: "Por pedir",
  ...MANAGEMENT_STATUS_LABELS,
};

export const AVAILABILITY_AXIS_LABELS: Record<AvailabilityAxis, string> = {
  ESPERANDO: "Esperando",
  LLEGO_BODEGA: "Llegó a bodega",
  DISPONIBLE_PARCIAL: "Disponible parcial",
  DISPONIBLE_COMPLETO: "Disponible completo",
};

export const DEADLINE_AXIS_LABELS: Record<DeadlineAxis, string> = {
  atrasadas: "Atrasadas",
  proximas: "Próximas (24 h)",
};

export const CUSTOMER_AXIS_LABELS: Record<CustomerAxis, string> = {
  POR_CONTACTAR: "Por contactar",
  CONTACTADO: "Contactado",
  FACTURADO: "Facturado",
  ENTREGADO: "Entregado",
  CANCELADO: "Cancelado",
};

function pick<T extends string>(
  allowed: readonly T[],
  raw: string | undefined,
): T | undefined {
  return allowed.includes(raw as T) ? (raw as T) : undefined;
}

/**
 * Lee los ejes de la URL.
 *
 * Un valor que no está en la lista se IGNORA y equivale a no filtrar. No es
 * cortesía: estos valores viajan a un enum de PostgreSQL, y pasarle uno
 * inventado revienta la consulta. `?purchase=cualquier-cosa` tiene que dar la
 * vista sin filtrar, nunca un error.
 */
export function parseReviewAxes(raw: {
  purchase?: string;
  availability?: string;
  customer?: string;
  entrega?: string;
}): ReviewAxes {
  const purchase = pick(PURCHASE_AXIS_VALUES, raw.purchase);
  const availability = pick(AVAILABILITY_AXIS_VALUES, raw.availability);
  const customer = pick(CUSTOMER_AXIS_VALUES, raw.customer);
  const deadline = pick(DEADLINE_AXIS_VALUES, raw.entrega);

  return {
    ...(purchase ? { purchase } : {}),
    ...(availability ? { availability } : {}),
    ...(customer ? { customer } : {}),
    ...(deadline ? { deadline } : {}),
  };
}

export function hasActiveAxis(axes: ReviewAxes): boolean {
  return Boolean(axes.purchase || axes.availability || axes.customer || axes.deadline);
}

/**
 * Arma el enlace de la vista con los ejes indicados.
 *
 * NUNCA lleva `cursor`: cambiar un filtro cambia el conjunto, y el cursor de la
 * página anterior apunta a una fila que el filtro nuevo puede no contener.
 * Arrastrarlo mostraría una página intermedia como si fuera la primera.
 */
export function reviewHref(params: ReviewView): string {
  return buildHref(params, null);
}

/**
 * El enlace a la página siguiente: la misma vista, con el cursor.
 *
 * Comparte la construcción con `reviewHref` a propósito. Si "ver más" armara la
 * URL por su cuenta, perdería un filtro cada vez que se agregue uno —que es
 * justo lo que hoy le pasa a la vista de detalle con `view`.
 */
export function reviewPageHref(params: ReviewView & { cursor: string }): string {
  return buildHref(params, params.cursor);
}

type ReviewView = {
  scope: "active" | "history";
  view: "lista" | "detalle";
  axes: ReviewAxes;
  // Sobre qué ruta se arma el enlace. Por defecto `/pendientes`, que es donde
  // nacieron estos filtros. El módulo de revisión pasa la suya: sin esto, cada
  // filtro devolvía al usuario a la cola operativa y lo expulsaba del módulo
  // en el primer clic.
  basePath?: string;
};

function buildHref(params: ReviewView, cursor: string | null): string {
  const query = new URLSearchParams();
  if (cursor) query.set("cursor", cursor);
  if (params.scope === "history") query.set("scope", "history");
  if (params.view === "detalle") query.set("view", "detalle");
  if (params.axes.purchase) query.set("purchase", params.axes.purchase);
  if (params.axes.availability) query.set("availability", params.axes.availability);
  if (params.axes.customer) query.set("customer", params.axes.customer);
  if (params.axes.deadline) query.set("entrega", params.axes.deadline);

  const search = query.toString();
  const basePath = params.basePath ?? "/pendientes";
  return search ? `${basePath}?${search}` : basePath;
}

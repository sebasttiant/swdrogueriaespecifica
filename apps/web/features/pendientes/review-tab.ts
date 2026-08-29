import { SUPPLY_TAB } from "@/features/faltantes/missing-scope";

// --------------------------------------------------------------------------
// Las dos mitades de Revisión de pendientes, como eje puro de la URL.
//
//   seguimiento    ¿cómo viene el compromiso con el cliente? Promesa, abono,
//                  contacto, entrega. Es lo que la pantalla ya hacía.
//   abastecimiento ¿qué hay que COMPRAR para cumplir esos pedidos? La misma
//                  mesa de trabajo de Revisión de faltantes, con las mismas
//                  palabras y el mismo gesto, pero sobre lo que nació de un
//                  pedido de cliente.
//
// Son dos preguntas distintas del mismo gerente en dos momentos distintos del
// día. Mezcladas en una lista, la columna de acciones tendría que servir a la
// vez para "llamar al cliente" y para "pedirle al proveedor": así se llegó a
// botones ambiguos antes, y hubo que deshacerlo.
//
// El abastecimiento de ESTANTERÍA no vive acá: eso es Revisión de faltantes.
// El ORIGEN decide la pantalla.
//
// PURO: no toca Prisma ni el reloj. La página lo usa para leer la URL y el
// componente de pestañas para pintarse.
// --------------------------------------------------------------------------

export const REVIEW_TABS = ["seguimiento", SUPPLY_TAB] as const;

export type ReviewTab = (typeof REVIEW_TABS)[number];

export const REVIEW_TAB_LABELS: Record<ReviewTab, string> = {
  seguimiento: "Seguimiento",
  [SUPPLY_TAB]: "Abastecimiento",
};

/**
 * Lee el `?tab=` de la URL. Cualquier valor desconocido cae en seguimiento: el
 * parámetro es input del usuario y no puede abrir una vista que no existe.
 *
 * El default es seguimiento a propósito: es lo que la pantalla hacía antes de
 * que existiera esta pestaña, así que un enlace viejo llega al mismo lugar.
 */
export function resolveReviewTab(param?: string | null): ReviewTab {
  return REVIEW_TABS.includes(param as ReviewTab)
    ? (param as ReviewTab)
    : "seguimiento";
}

/**
 * URL de una mitad. Cambiar de mitad EMPIEZA LIMPIO: los filtros de
 * seguimiento y los de abastecimiento no se entienden entre sí, y arrastrarlos
 * dejaría la otra pestaña filtrada por algo que desde ahí no se ve.
 */
export function reviewTabHref(tab: ReviewTab): string {
  return tab === "seguimiento" ? "?" : `?tab=${tab}`;
}

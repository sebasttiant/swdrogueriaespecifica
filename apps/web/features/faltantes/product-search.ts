/**
 * Estado puro del selector asíncrono de productos del alta manual de faltantes.
 *
 * Vive fuera del componente por dos motivos: mantiene el formulario como una
 * cáscara delgada y deja que el comportamiento difícil (respuestas fuera de
 * orden, paginación por consulta, recuperación de errores) se pruebe de forma
 * determinista sin necesidad de un DOM.
 *
 * Cada búsqueda se emite con un `requestId` monótono. Una respuesta solo se
 * aplica si su id sigue siendo el vigente: así una respuesta vieja nunca puede
 * repoblar los resultados de una consulta nueva.
 */

export type ProductOption = {
  id: string;
  name: string;
  code: string;
};

export type ProductSearchStatus = "idle" | "searching" | "error";

export type ProductSearchState = {
  query: string;
  items: ProductOption[];
  nextCursor: string | null;
  selected: ProductOption | null;
  status: ProductSearchStatus;
  /** True una vez que una búsqueda resolvió: distingue "vacío" de "sin buscar". */
  hasSearched: boolean;
  /** Id de la última solicitud emitida. Solo su respuesta es aceptada. */
  requestId: number;
};

export const INITIAL_PRODUCT_SEARCH_STATE: ProductSearchState = {
  query: "",
  items: [],
  nextCursor: null,
  selected: null,
  status: "idle",
  hasSearched: false,
  requestId: 0,
};

/**
 * El usuario editó el texto. Invalida cualquier solicitud en vuelo y descarta
 * resultados, cursor y selección: pertenecían a otra consulta.
 */
export function queryChanged(
  state: ProductSearchState,
  query: string,
  requestId: number,
): ProductSearchState {
  return {
    ...state,
    query,
    items: [],
    nextCursor: null,
    selected: null,
    status: "idle",
    hasSearched: false,
    requestId,
  };
}

/**
 * Se emitió una solicitud. Sin `cursor` es una búsqueda nueva y limpia la
 * página anterior; con `cursor` es un "ver más" y conserva lo ya cargado.
 */
export function searchStarted(
  state: ProductSearchState,
  requestId: number,
  cursor: string | null,
): ProductSearchState {
  const isLoadMore = cursor !== null;

  return {
    ...state,
    items: isLoadMore ? state.items : [],
    nextCursor: isLoadMore ? state.nextCursor : null,
    status: "searching",
    hasSearched: isLoadMore ? state.hasSearched : false,
    requestId,
  };
}

/**
 * Llegó una respuesta. Se ignora si ya no corresponde a la solicitud vigente.
 * Los ítems se agregan a los actuales; una búsqueda nueva ya los vació al
 * arrancar, así que agregar equivale a reemplazar.
 */
export function searchSucceeded(
  state: ProductSearchState,
  requestId: number,
  items: ProductOption[],
  nextCursor: string | null,
): ProductSearchState {
  if (requestId !== state.requestId) return state;

  const known = new Set(state.items.map((item) => item.id));

  return {
    ...state,
    items: [...state.items, ...items.filter((item) => !known.has(item.id))],
    nextCursor,
    status: "idle",
    hasSearched: true,
  };
}

/**
 * La solicitud vigente falló. Conserva los resultados ya cargados para que un
 * "ver más" fallido no borre la página que el usuario está mirando.
 */
export function searchFailed(
  state: ProductSearchState,
  requestId: number,
): ProductSearchState {
  if (requestId !== state.requestId) return state;

  return { ...state, status: "error" };
}

export function productSelected(
  state: ProductSearchState,
  product: ProductOption,
): ProductSearchState {
  return { ...state, selected: product };
}

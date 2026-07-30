"use client";

import { Link2 } from "lucide-react";
import { useActionState, useId, useRef, useState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import {
  INITIAL_PRODUCT_SEARCH_STATE,
  productSelected,
  queryChanged,
  searchFailed,
  searchStarted,
  searchSucceeded,
} from "@/features/faltantes/product-search";
import { searchActiveProductsForMissingItemAction } from "@/server/actions/missing-item.actions";
import {
  linkMissingReportToProductAction,
  type LinkMissingReportActionState,
} from "@/server/actions/missing-report.actions";

const INITIAL_STATE: LinkMissingReportActionState = { error: null, ok: false };

type ReportLinkFormProps = {
  normalizedName: string;
  defaultOpen?: boolean;
};

// Vinculación de un grupo de reportes con un producto del catálogo.
//
// El formulario se expande DEBAJO del grupo en vez de abrir un modal: en el
// celular un modal tapa la cola y obliga a cerrar para comparar con los otros
// reportes. Colapsado, la tarjeta solo suma un botón.
//
// El buscador reutiliza el módulo puro `product-search` (PR #69), que ya resuelve
// respuestas fuera de orden y paginación por consulta.
//
// RIESGO LATENTE DOCUMENTADO: `searchActiveProductsForMissingItemAction` exige
// `canCreateMissingItems`, no `canReviewMissingReports`. Hoy coincide porque
// ADMIN/SUPERADMIN tienen ambas. Si `canReviewMissingReports` se extiende a roles
// sin `canCreateMissingItems`, esta acción fallará en silencio (redirect) con el
// botón visible.
export function ReportLinkForm({ normalizedName, defaultOpen = false }: ReportLinkFormProps) {
  const [state, formAction, isPending] = useActionState(
    linkMissingReportToProductAction,
    INITIAL_STATE,
  );
  const [open, setOpen] = useState(defaultOpen);
  const [search, setSearch] = useState(INITIAL_PRODUCT_SEARCH_STATE);
  // Id monótono de solicitud: una respuesta vieja no repuebla los resultados de
  // una consulta nueva.
  const requestIdRef = useRef(0);
  const queryId = useId();
  const resultsId = useId();

  function handleQueryChange(query: string) {
    const requestId = (requestIdRef.current += 1);
    setSearch((current) => queryChanged(current, query, requestId));
  }

  async function runSearch(cursor: string | null) {
    const query = search.query.trim();
    if (!query) return;

    const requestId = (requestIdRef.current += 1);
    setSearch((current) => searchStarted(current, requestId, cursor));

    try {
      const result = await searchActiveProductsForMissingItemAction(query, cursor);
      setSearch((current) =>
        searchSucceeded(current, requestId, result.items, result.nextCursor),
      );
    } catch {
      setSearch((current) => searchFailed(current, requestId));
    }
  }

  const feedback = state.error ? (
    <p role="alert" className="text-sm font-medium text-danger break-words">
      {state.error}
    </p>
  ) : state.ok ? (
    <p role="status" className="text-sm font-medium text-success break-words">
      Faltante creado. Gerencia puede definir cantidad y pedirlo en /faltantes.
    </p>
  ) : null;

  if (!open) {
    return (
      <div className="space-y-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => setOpen(true)}
          className="w-full"
        >
          <Link2 aria-hidden="true" className="h-4 w-4" />
          Vincular producto
        </Button>
        {feedback}
      </div>
    );
  }

  const isSearching = search.status === "searching";
  const hasFailed = search.status === "error";
  const isEmpty = search.hasSearched && search.items.length === 0;

  return (
    <form action={formAction} className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
      <input type="hidden" name="normalizedName" value={normalizedName} />
      <input type="hidden" name="productId" value={search.selected?.id ?? ""} />

      <Field label="Producto del catálogo" htmlFor={queryId}>
        <div className="space-y-2">
          <Input
            id={queryId}
            type="search"
            value={search.query}
            onChange={(event) => handleQueryChange(event.target.value)}
            placeholder="Buscá por nombre o código"
            aria-controls={resultsId}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => runSearch(null)}
            disabled={isSearching || !search.query.trim()}
            className="w-full"
          >
            {isSearching ? "Buscando…" : "Buscar producto"}
          </Button>

          {search.selected ? (
            <p className="break-words text-sm font-medium text-text">
              Seleccionado: {search.selected.name} ({search.selected.code})
            </p>
          ) : null}

          {hasFailed ? (
            <p role="alert" className="text-sm font-medium text-danger">
              No se pudo buscar productos. Reintentá.
            </p>
          ) : null}

          <div id={resultsId} aria-busy={isSearching} className="space-y-1">
            {isEmpty && !hasFailed ? (
              <p role="status" className="text-sm text-muted-foreground">
                Sin resultados para esa búsqueda.
              </p>
            ) : null}

            {search.items.length > 0 ? (
              <div className="space-y-1" role="listbox" aria-label="Resultados de productos">
                {search.items.map((product) => (
                  <Button
                    key={product.id}
                    type="button"
                    role="option"
                    aria-selected={search.selected?.id === product.id}
                    variant={search.selected?.id === product.id ? "secondary" : "ghost"}
                    onClick={() => setSearch((current) => productSelected(current, product))}
                    className="w-full justify-start text-left"
                  >
                    {product.name} ({product.code})
                  </Button>
                ))}
                {search.nextCursor ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => runSearch(search.nextCursor)}
                    disabled={isSearching}
                    className="w-full"
                  >
                    Ver más resultados
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </Field>

      {feedback}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setOpen(false)}
          disabled={isPending}
          className="flex-1"
        >
          Cancelar
        </Button>
        {/* Confirmar queda visible pero DESHABILITADO hasta elegir un producto:
            así gerencia ve cuál es el paso siguiente, en vez de que el botón
            aparezca de golpe. Sin producto la acción se rechazaría igual del
            lado del servidor. */}
        <Button
          type="submit"
          disabled={isPending || !search.selected}
          className="flex-1"
        >
          <Link2 aria-hidden="true" className="h-4 w-4" />
          {isPending ? "Vinculando…" : "Confirmar vínculo"}
        </Button>
      </div>
    </form>
  );
}

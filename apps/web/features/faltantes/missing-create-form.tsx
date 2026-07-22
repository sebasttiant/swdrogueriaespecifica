"use client";

import { Plus } from "lucide-react";
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
  type ProductOption,
} from "@/features/faltantes/product-search";
import {
  createMissingItemAction,
  searchActiveProductsForMissingItemAction,
  type MissingItemActionState,
} from "@/server/actions/missing-item.actions";

const INITIAL_STATE: MissingItemActionState = { error: null, ok: false };

export type MissingCreateProductOption = ProductOption;

type MissingCreateFormProps = { defaultOpen?: boolean };

export function MissingCreateForm({ defaultOpen = false }: MissingCreateFormProps) {
  const [state, formAction, isPending] = useActionState(
    createMissingItemAction,
    INITIAL_STATE,
  );
  const [open, setOpen] = useState(defaultOpen);
  const [search, setSearch] = useState(INITIAL_PRODUCT_SEARCH_STATE);
  // Contador monótono de solicitudes: la respuesta de una búsqueda vieja se
  // descarta en lugar de pisar los resultados de la consulta vigente.
  const requestIdRef = useRef(0);
  const productId = useId();
  const quantityId = useId();
  const noteId = useId();
  const resultsId = useId();

  function handleQueryChange(query: string) {
    // El id se captura ANTES de encolar la actualización, igual que en
    // `runSearch`: el updater no debe leer el ref cuando React lo aplique.
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

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" className="h-4 w-4" />
        Nuevo faltante
      </Button>
    );
  }

  const isSearching = search.status === "searching";
  const hasFailed = search.status === "error";
  const isEmpty = search.hasSearched && search.items.length === 0;
  // Si ya hay resultados en pantalla, el fallo fue de "ver más": el reintento
  // correcto es ese botón, que conserva el cursor. Este botón reinicia la
  // búsqueda, así que no debe ofrecerse como reintento en ese caso.
  const canRetrySearch = hasFailed && search.items.length === 0;

  return (
    <form action={formAction} className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
      <Field label="Producto" htmlFor={productId}>
        <input type="hidden" name="productId" value={search.selected?.id ?? ""} />
        <div className="space-y-2">
          <Input
            id={productId}
            type="search"
            value={search.query}
            onChange={(event) => handleQueryChange(event.target.value)}
            placeholder="Buscá por nombre o código"
            required={!search.selected}
            aria-controls={resultsId}
            aria-describedby={hasFailed ? `${resultsId}-error` : undefined}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => runSearch(null)}
            disabled={isSearching || !search.query.trim()}
            className="w-full"
          >
            {isSearching
              ? "Buscando…"
              : canRetrySearch
                ? "Reintentar búsqueda"
                : "Buscar producto"}
          </Button>

          {search.selected ? (
            <p className="text-sm font-medium text-text">
              Seleccionado: {search.selected.name} ({search.selected.code})
            </p>
          ) : null}

          {hasFailed ? (
            <p id={`${resultsId}-error`} role="alert" className="text-sm font-medium text-danger">
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

      <Field label="Cantidad" htmlFor={quantityId}>
        <Input
          id={quantityId}
          name="quantity"
          type="number"
          min={1}
          step={1}
          required
          defaultValue={1}
        />
      </Field>

      <Field label="Nota (opcional)" htmlFor={noteId}>
        <Input id={noteId} name="note" maxLength={300} placeholder="Detalle operativo" />
      </Field>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm font-medium text-success">
          Faltante registrado.
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} className="flex-1">
          Cancelar
        </Button>
        <Button type="submit" disabled={isPending} className="flex-1">
          <Plus aria-hidden="true" className="h-4 w-4" />
          {isPending ? "Guardando…" : "Crear faltante"}
        </Button>
      </div>
    </form>
  );
}

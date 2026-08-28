"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils/cn";
import { useBodyScrollLock } from "@/lib/hooks/use-body-scroll-lock";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { prepareProductQuery } from "@/lib/productos/search-query";
import {
  searchProductsAction,
  type ProductSuggestion,
} from "@/server/actions/product-search.actions";
import { Input } from "@/app/_components/ui/input";

// ---------------------------------------------------------------------------
// TopbarSearch — client island
//
// Desktop (lg+): compact search <form> inside the topbar center slot.
//   Submitting navigates to /productos?q=<value> (GET via router.push).
//
// Mobile (<lg): a Search icon button that opens a full-height OPAQUE top layer
//   (h-dvh, safe-area aware). The input + close button stay grouped at the top;
//   matching products stream in directly below as you type (debounced
//   autocomplete) so the result is reachable without scrolling past the page.
//   Tapping a suggestion navigates to that product; Enter runs the full search
//   at /productos?q=. Escape or the X button closes the layer.
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 200;

function buildSearchUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "/productos";
  return `/productos?q=${encodeURIComponent(trimmed)}`;
}

export function TopbarSearch() {
  const router = useRouter();
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<ProductSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);
  const overlayInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useBodyScrollLock(overlayOpen);
  useFocusTrap(overlayOpen, dialogRef);

  // Debounced autocomplete: only fires for queries that clear the minimum
  // length. A request counter discards out-of-order responses so a slow early
  // query never overwrites a newer one.
  const requestIdRef = useRef(0);
  useEffect(() => {
    if (!overlayOpen) return;

    const prepared = prepareProductQuery(query);
    const requestId = ++requestIdRef.current;

    async function run(term: string) {
      try {
        const results = await searchProductsAction(term);
        // A newer request (or a close, which bumps the id) supersedes this one:
        // its late response must never repopulate the list.
        if (requestId === requestIdRef.current) {
          setSuggestions(results);
          setErrored(false);
        }
      } catch {
        if (requestId === requestIdRef.current) {
          setSuggestions([]);
          setErrored(true);
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    }

    // All state updates run inside the debounced callback (never synchronously
    // in the effect body) so a fresh keystroke cancels the pending timer first.
    const timer = setTimeout(() => {
      if (requestId !== requestIdRef.current) return;
      if (!prepared) {
        setSuggestions([]);
        setErrored(false);
        setLoading(false);
        return;
      }
      setErrored(false);
      setLoading(true);
      void run(prepared);
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, overlayOpen]);

  function handleDesktopSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const q = (form.elements.namedItem("q") as HTMLInputElement).value;
    router.push(buildSearchUrl(q));
  }

  function handleMobileSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    closeOverlay();
    router.push(buildSearchUrl(query));
  }

  function openOverlay() {
    setOverlayOpen(true);
    // Focus the input after the overlay renders.
    requestAnimationFrame(() => {
      overlayInputRef.current?.focus();
    });
  }

  function closeOverlay() {
    // Invalidate any in-flight request so a late response can't repopulate
    // suggestions after the overlay is closed (or reopened).
    requestIdRef.current += 1;
    setOverlayOpen(false);
    setQuery("");
    setSuggestions([]);
    setLoading(false);
    setErrored(false);
  }

  function selectSuggestion() {
    closeOverlay();
  }

  function handleOverlayKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") closeOverlay();
  }

  const prepared = prepareProductQuery(query);
  const showEmptyState =
    prepared !== null && !loading && suggestions.length === 0;

  return (
    <>
      {/* Desktop: compact inline form — visible on lg+ only */}
      <form
        onSubmit={handleDesktopSubmit}
        role="search"
        aria-label="Buscar producto"
        className="hidden lg:flex items-center gap-2 w-72 xl:w-96"
      >
        <div className="relative w-full">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
          />
          <Input
            type="search"
            name="q"
            placeholder="Buscar producto por nombre o código…"
            autoComplete="off"
            className="pl-9 text-sm"
            aria-label="Buscar producto por nombre o código"
          />
        </div>
      </form>

      {/* Mobile: Search icon button — visible below lg */}
      <button
        type="button"
        onClick={openOverlay}
        aria-label="Abrir búsqueda"
        className="flex lg:hidden items-center justify-center min-h-11 min-w-11 rounded-[var(--radius-btn)] text-muted-foreground hover:text-text hover:bg-muted/40 transition-colors"
      >
        <Search className="h-5 w-5" aria-hidden="true" />
      </button>

      {/* Mobile overlay — opaque full-height top layer */}
      {overlayOpen ? (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Buscar producto"
          onKeyDown={handleOverlayKeyDown}
          className="fixed inset-x-0 top-0 z-50 flex h-dvh flex-col bg-background animate-fade-in lg:hidden motion-reduce:animate-none"
        >
          {/* Grouped header: input + close, padded for the top safe area */}
          <div className="flex items-center gap-2 border-b border-border bg-surface px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
            <form
              onSubmit={handleMobileSubmit}
              role="search"
              aria-label="Buscar producto"
              className="flex flex-1 items-center gap-2"
            >
              <div className="relative flex-1">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
                />
                <Input
                  ref={overlayInputRef}
                  type="search"
                  name="q"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar producto por nombre o código…"
                  autoComplete="off"
                  enterKeyHint="search"
                  className="pl-9 text-sm"
                  aria-label="Buscar producto por nombre o código"
                />
              </div>
            </form>
            <button
              type="button"
              onClick={closeOverlay}
              aria-label="Cerrar búsqueda"
              className={cn(
                "flex items-center justify-center min-h-11 min-w-11",
                "rounded-[var(--radius-btn)] text-muted-foreground",
                "hover:text-text hover:bg-muted/40 transition-colors shrink-0",
              )}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          {/* Results region: scrolls above the keyboard, grouped under the input */}
          <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {loading ? (
              <p className="px-1 py-2 text-sm text-muted-foreground" aria-live="polite">
                Buscando…
              </p>
            ) : errored ? (
              <p className="px-1 py-2 text-sm text-danger" role="alert">
                No se pudo buscar. Revisá la conexión e intentá de nuevo.
              </p>
            ) : suggestions.length > 0 ? (
              <ul className="space-y-1" aria-label="Resultados de búsqueda">
                {suggestions.map((product) => (
                  <li key={product.id}>
                    <Link prefetch={false}
                      href={`/productos/${product.id}`}
                      onClick={selectSuggestion}
                      className="flex min-h-11 flex-col justify-center rounded-[var(--radius-btn)] px-3 py-2 hover:bg-muted/50"
                    >
                      <span className="font-medium text-text">
                        {product.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {product.code} · {product.unit}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : showEmptyState ? (
              <p className="px-1 py-2 text-sm text-muted-foreground" aria-live="polite">
                Sin resultados para “{query.trim()}”.
              </p>
            ) : (
              <p className="px-1 py-2 text-sm text-muted-foreground">
                Escribí al menos 2 caracteres para ver coincidencias.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

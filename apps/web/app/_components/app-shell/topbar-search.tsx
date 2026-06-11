"use client";

import { useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils/cn";
import { Input } from "@/app/_components/ui/input";

// ---------------------------------------------------------------------------
// TopbarSearch — client island
//
// Desktop (lg+): compact search <form> inside the topbar center slot.
//   Submitting navigates to /productos?q=<value> (GET via router.push).
//
// Mobile (<lg): a Search icon button that toggles a full-width overlay.
//   The overlay contains the same Input + submit. Pressing Escape or the X
//   button closes the overlay. The input is focused when the overlay opens.
// ---------------------------------------------------------------------------

function buildSearchUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "/productos";
  return `/productos?q=${encodeURIComponent(trimmed)}`;
}

export function TopbarSearch() {
  const router = useRouter();
  const [overlayOpen, setOverlayOpen] = useState(false);
  const overlayInputRef = useRef<HTMLInputElement>(null);

  function handleDesktopSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const q = (form.elements.namedItem("q") as HTMLInputElement).value;
    router.push(buildSearchUrl(q));
  }

  function handleMobileSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const q = (form.elements.namedItem("q") as HTMLInputElement).value;
    setOverlayOpen(false);
    router.push(buildSearchUrl(q));
  }

  function openOverlay() {
    setOverlayOpen(true);
    // Focus the input after the overlay renders.
    requestAnimationFrame(() => {
      overlayInputRef.current?.focus();
    });
  }

  function closeOverlay() {
    setOverlayOpen(false);
  }

  function handleOverlayKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") closeOverlay();
  }

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

      {/* Mobile overlay */}
      {overlayOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Buscar producto"
          onKeyDown={handleOverlayKeyDown}
          className="fixed inset-0 z-50 flex flex-col bg-surface/95 backdrop-blur px-4 pt-4 lg:hidden"
        >
          <form
            onSubmit={handleMobileSubmit}
            role="search"
            aria-label="Buscar producto"
            className="flex items-center gap-2"
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
                placeholder="Buscar producto por nombre o código…"
                autoComplete="off"
                className="pl-9 text-sm"
                aria-label="Buscar producto por nombre o código"
              />
            </div>
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
          </form>
        </div>
      ) : null}
    </>
  );
}

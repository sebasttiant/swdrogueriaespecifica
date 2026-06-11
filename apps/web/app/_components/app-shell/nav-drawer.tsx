"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { X, Menu } from "lucide-react";

import type { SessionRole } from "@/lib/auth/session";
import { visibleNavItems } from "@/lib/constants/nav";
import { useBodyScrollLock } from "@/lib/hooks/use-body-scroll-lock";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { cn } from "@/lib/utils/cn";

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

type NavDrawerProps = {
  role: SessionRole | null;
};

// Client island — hamburger trigger + slide-over drawer for <lg viewports.
// Receives role from the already-resolved AppShell session; does NOT resolve
// the session internally.
export function NavDrawer({ role }: NavDrawerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstLinkRef = useRef<HTMLAnchorElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Distinguishes the initial mount (closed) from a real close, so focus is
  // restored to the trigger only after the drawer has actually been opened.
  const hasOpenedRef = useRef(false);

  const items = visibleNavItems(role);

  // Lock the page behind the drawer so it reads as a real overlay, not a
  // sidebar squeezed into mobile, and keep keyboard focus inside the panel.
  useBodyScrollLock(isOpen);
  useFocusTrap(isOpen, panelRef);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const openDrawer = useCallback(() => {
    setIsOpen(true);
  }, []);

  // Focus management: focus the first link when the drawer opens; restore
  // focus to the trigger ONLY after a real close — never on initial mount.
  useEffect(() => {
    if (isOpen) {
      hasOpenedRef.current = true;
      firstLinkRef.current?.focus();
    } else if (hasOpenedRef.current) {
      triggerRef.current?.focus();
    }
  }, [isOpen]);

  // Close on Esc keydown — only while open. setState runs inside the event
  // callback, not synchronously in the effect body.
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, close]);

  const drawerId = "nav-drawer-panel";

  return (
    <>
      {/* Hamburger trigger — visible only <lg, always mounted */}
      <button
        ref={triggerRef}
        type="button"
        onClick={openDrawer}
        aria-label="Abrir menú"
        aria-expanded={isOpen}
        aria-controls={drawerId}
        className="flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-btn)] text-text hover:bg-muted lg:hidden"
      >
        <Menu className="size-6" aria-hidden />
      </button>

      {/* Backdrop + slide-over panel are mounted ONLY when open, so the closed
          drawer leaves no focusable links and no announceable dialog in the DOM
          (never reachable by tab or screen readers when collapsed). */}
      {isOpen && (
        <>
          <div
            className="fixed inset-x-0 top-0 z-40 h-dvh animate-fade-in bg-black/50 lg:hidden motion-reduce:animate-none"
            aria-hidden="true"
            onClick={close}
          />

          <div
            ref={panelRef}
            id={drawerId}
            role="dialog"
            aria-modal="true"
            aria-label="Menú de navegación"
            className="fixed left-0 top-0 z-50 flex h-dvh w-72 max-w-[85vw] animate-drawer-in flex-col border-r border-border bg-surface shadow-xl lg:hidden motion-reduce:animate-none"
          >
            {/* Panel header */}
            <div className="flex h-16 items-center justify-between border-b border-border px-4">
              <span className="text-base font-semibold text-text">
                Navegación
              </span>
              <button
                type="button"
                onClick={close}
                aria-label="Cerrar menú"
                className="flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-btn)] text-text hover:bg-muted"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>

            {/* Nav links — onClick closes drawer on navigation */}
            <nav
              className="flex-1 overflow-y-auto overscroll-contain p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
              aria-label="Menú de navegación"
            >
              <ul className="space-y-1">
                {items.map((item, index) => {
                  const active = isActive(pathname, item.href);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        ref={index === 0 ? firstLinkRef : undefined}
                        aria-current={active ? "page" : undefined}
                        onClick={close}
                        className={cn(
                          "flex min-h-11 items-center gap-3 rounded-[var(--radius-btn)] px-3 py-2.5 text-base font-medium transition-colors duration-150 ease-in-out motion-reduce:transition-none",
                          active
                            ? "bg-primary text-primary-foreground"
                            : "text-text hover:bg-muted",
                        )}
                      >
                        <Icon className="size-5 shrink-0" aria-hidden />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </div>
        </>
      )}
    </>
  );
}

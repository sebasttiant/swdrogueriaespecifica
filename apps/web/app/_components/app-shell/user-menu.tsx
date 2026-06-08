"use client";

import { useEffect, useRef, useState } from "react";
import { LogOut, UserCircle2 } from "lucide-react";

import { logoutAction } from "@/server/actions/auth.actions";

type UserMenuProps = {
  name: string;
  email: string;
};

// Menú de cuenta. Al abrirlo muestra el usuario logueado y permite cerrar
// sesión. La lógica de logout sigue siendo la misma server action; acá solo
// agregamos la capa visual + accesibilidad (teclado, click afuera, Escape).
export function UserMenu({ name, email }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Cuenta"
        className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
      >
        <UserCircle2 className="size-7" aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-12 z-40 w-60 overflow-hidden rounded-[var(--radius-btn)] border border-border bg-surface shadow-lg"
        >
          <div className="border-b border-border px-4 py-3">
            <p className="truncate font-semibold text-text">{name}</p>
            <p className="truncate text-sm text-muted-foreground">{email}</p>
          </div>
          <form action={logoutAction}>
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-base font-medium text-text hover:bg-muted"
            >
              <LogOut className="size-5 shrink-0" aria-hidden />
              Cerrar sesión
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

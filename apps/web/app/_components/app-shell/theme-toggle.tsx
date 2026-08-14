"use client";

import { Moon, Sun } from "lucide-react";

// Botón de tema claro/oscuro. Vive en la topbar, así que solo aparece con la
// sesión iniciada.
//
// No usa estado de React a propósito: el tema vive en `data-theme` del <html>
// y los dos íconos se alternan por CSS (`dark:hidden` / `hidden dark:block`).
// Si el ícono dependiera de un `useState`, el servidor renderizaría siempre el
// mismo y en oscuro se vería el ícono equivocado hasta que hidrate. Así no hay
// desajuste de hidratación ni parpadeo.
//
// Se muestra el ícono de DESTINO, no el del estado actual: en claro se ve la
// luna (tocar = oscurecer) y en oscuro se ve el sol.
type ThemeToggleProps = {
  // "icon": botón redondo para la topbar (escritorio).
  // "menu": fila dentro del menú de cuenta (celular, donde la barra no da).
  variant?: "icon" | "menu";
};

export function ThemeToggle({ variant = "icon" }: ThemeToggleProps) {
  function toggleTheme() {
    const root = document.documentElement;
    const next = root.dataset.theme === "dark" ? "light" : "dark";

    root.dataset.theme = next;
    // Mantiene los controles nativos (scrollbar, date picker) en sintonía.
    root.style.colorScheme = next;

    try {
      localStorage.setItem("theme", next);
    } catch {
      // Modo privado o almacenamiento bloqueado: el tema igual cambia en esta
      // pantalla, solo no se recuerda para la próxima visita.
    }
  }

  if (variant === "menu") {
    return (
      <button
        type="button"
        onClick={toggleTheme}
        role="menuitem"
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-base font-medium text-text hover:bg-muted"
      >
        <Moon className="size-5 shrink-0 dark:hidden" aria-hidden />
        <Sun className="hidden size-5 shrink-0 dark:block" aria-hidden />
        Cambiar tema
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Cambiar entre tema claro y oscuro"
      title="Cambiar tema"
      className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
    >
      <Moon className="size-6 dark:hidden" aria-hidden />
      <Sun className="hidden size-6 dark:block" aria-hidden />
    </button>
  );
}

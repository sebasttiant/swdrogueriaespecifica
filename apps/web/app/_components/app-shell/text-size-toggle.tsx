"use client";

import { ALargeSmall } from "lucide-react";

// Tamaño de texto. Un solo botón que cicla Normal → Grande → Muy grande y
// vuelve a empezar, para no ocupar lugar en la topbar.
//
// No es el zoom del navegador: cambia `font-size` del <html> y, como toda la
// interfaz mide en rem, se reescala tipografía Y espaciado manteniendo el
// diseño responsive. Por eso no aparece scroll horizontal ni se desacomoda la
// barra inferior, que es lo que sí pasa al hacer pinch sobre la pantalla.
//
// Sin estado de React, igual que el botón de tema: el valor vive en
// `data-text-size` del <html>, así no hay desajuste de hidratación.
const SIZES = ["normal", "grande", "extra"] as const;
type Size = (typeof SIZES)[number];

type TextSizeToggleProps = {
  // "icon": botón redondo para la topbar (escritorio).
  // "menu": fila dentro del menú de cuenta (celular, donde la barra no da).
  variant?: "icon" | "menu";
};

export function TextSizeToggle({ variant = "icon" }: TextSizeToggleProps) {
  function cycleSize() {
    const root = document.documentElement;
    const current = (root.dataset.textSize ?? "normal") as Size;
    const index = SIZES.indexOf(current);
    // Si el atributo trae algo inesperado, indexOf da -1, el módulo devuelve 0
    // y el ciclo se reinicia en "normal". El `?? "normal"` es por el índice
    // opcional del tipado; en la práctica el módulo nunca se sale del rango.
    const next = SIZES[(index + 1) % SIZES.length] ?? "normal";

    root.dataset.textSize = next;

    try {
      localStorage.setItem("textSize", next);
    } catch {
      // Almacenamiento bloqueado: el cambio vale para esta pantalla y no se
      // recuerda. No es motivo para romper el botón.
    }
  }

  if (variant === "menu") {
    return (
      <button
        type="button"
        onClick={cycleSize}
        role="menuitem"
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-base font-medium text-text hover:bg-muted"
      >
        <ALargeSmall className="size-5 shrink-0" aria-hidden />
        Tamaño del texto
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={cycleSize}
      aria-label="Cambiar el tamaño del texto"
      title="Tamaño del texto"
      className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
    >
      <ALargeSmall className="size-6" aria-hidden />
    </button>
  );
}

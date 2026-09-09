import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

export type AlertTone = "danger" | "warning" | "success" | "neutral";

// Maps tone to background + border + text classes using the @theme tokens from globals.css.
// Mirrors the TONES pattern from badge.tsx — reuse existing tokens, no new colors.
//
// `danger` NO es un relleno pleno: es un ACENTO sobre superficie normal.
//
// Lo fue —bloque rojo entero, texto blanco— y hubo que deshacerlo. Con dos
// avisos de peligro en el tablero quedaban dos losas rojas apiladas; después
// quedó una sola, y seguía comiéndose la pantalla: un bloque saturado de ancho
// completo gana siempre contra las tarjetas, los números y el saludo, que son
// el trabajo de verdad.
//
// El arreglo NO es desaturar el rojo. Eso ya se probó y falló: mientras el
// rojo tuvo que ser TEXTO se lo aclaró hasta `#fb9494` y el dueño lo describió
// como "rosa, no incomoda". La urgencia no se pierde por el tono, se pierde
// por el tono LAVADO. Acá el rojo sigue entero —`--color-danger` sin diluir—
// y lo que se reduce es el ÁREA: un filo de 4 px en vez de un bloque.
//
// El patrón no se inventó para esto: es el mismo de la tarjeta "Estado general
// de la operación" del tablero (`border-l-4 border-l-danger` + el icono en un
// círculo tenue), que es lo único de esa pantalla que nadie objetó. Reusarlo
// deja UN solo lenguaje para "esto anda mal" en vez de dos que compiten.
const TONE_CLASSES: Record<AlertTone, string> = {
  danger: "bg-surface border-border border-l-4 border-l-danger text-text",
  warning: "bg-warning/10 border-warning/30 text-warning-foreground",
  success: "bg-success/10 border-success/30 text-success",
  neutral: "bg-muted border-border text-muted-foreground",
};

export type AlertProps = HTMLAttributes<HTMLDivElement> & {
  tone?: AlertTone;
  /** Accessibility role: use "alert" for danger (announced immediately), "status" for warning/info. */
  role?: "alert" | "status";
  children: ReactNode;
  className?: string;
};

/**
 * Alert / Notice presentational primitive.
 *
 * - Pure server-compatible component (no client logic, no state).
 * - Tones reuse the Tailwind 4 @theme tokens defined in globals.css.
 * - `role` defaults to "alert" for danger tone and "status" for all others.
 * - Use `className` passthrough for layout overrides (e.g. margins).
 */
export function Alert({
  tone = "neutral",
  role,
  children,
  className,
  ...props
}: AlertProps) {
  // Accessibility: danger alerts are announced immediately (role="alert");
  // informational notices use role="status" (polite queue).
  const resolvedRole = role ?? (tone === "danger" ? "alert" : "status");

  return (
    <div
      role={resolvedRole}
      className={cn(
        "rounded-lg border px-4 py-3 text-sm",
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

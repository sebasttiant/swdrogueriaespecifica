import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger" | "accent";

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
};

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning-foreground",
  danger: "bg-danger/10 text-danger",
  // Violeta: en la tabla que gerencia viene usando desde siempre, el morado
  // significa "no es una unidad, son varias". Se conserva ese color para que la
  // lectura sea la misma que ya tienen aprendida.
  accent: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
};

export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        // `rounded-lg` y NO `rounded-full`: varias insignias llevan frases, no
        // etiquetas de una palabra ("Cargado: 2 de 5 · podés facturar"). En una
        // columna angosta ese texto se parte en dos o tres líneas, y con radio
        // infinito el borde pasa a ser la mitad de la altura: queda un óvalo
        // deforme que no abraza el texto. Un radio fijo se ve bien con una
        // línea y con varias.
        //
        // `py-1` en lugar de `py-0.5` por lo mismo: media unidad alcanza para
        // una línea, pero deja el contenido apretado cuando son dos o tres.
        "inline-flex items-center rounded-lg px-2.5 py-1 text-sm font-medium",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

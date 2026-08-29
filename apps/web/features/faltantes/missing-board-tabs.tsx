import Link from "next/link";

import {
  MISSING_SCOPES,
  MISSING_SCOPE_LABELS,
  missingScopeHref,
  type MissingQueueScope,
} from "@/features/faltantes/missing-scope";
import type { MissingView } from "@/features/faltantes/missing-view";
import { cn } from "@/lib/utils/cn";

// --------------------------------------------------------------------------
// Las pestañas de gerencia en Revisión de faltantes.
//
// Tres son la cola real de faltantes (`MissingItem`) y la cuarta es el buzón
// de lo que reportaron los vendedores (`MissingReport`). Son modelos distintos
// y por eso viven en pestañas y no mezclados: aprobar un reporte es lo que
// CREA un faltante, así que el buzón es la puerta de entrada a la misma cola,
// no una lista paralela.
//
// Antes el buzón ocupaba una entrada propia del menú, con el mismo título y
// las mismas cuatro palabras que esta pantalla. Dos tableros que se llamaban
// igual sobre datos distintos: por eso parecía que el sistema estaba
// desacoplado cuando no lo estaba.
//
// Altura de dedo (44px): se usan desde el celular.
// --------------------------------------------------------------------------

/** Valor de `?scope=` que muestra el buzón en vez de la cola. */
export const REPORTS_TAB_SCOPE = "reportes";

const TAB_BASE =
  "inline-flex min-h-11 items-center gap-2 rounded-lg px-4 transition-colors";

function tabClasses(active: boolean): string {
  return cn(
    TAB_BASE,
    active
      ? "bg-primary text-primary-foreground"
      : "bg-muted/60 text-muted-foreground hover:bg-muted",
  );
}

type MissingBoardTabsProps = {
  /** El alcance activo, o `REPORTS_TAB_SCOPE` si se está viendo el buzón. */
  active: MissingQueueScope | typeof REPORTS_TAB_SCOPE;
  view: MissingView;
  /** "Cuánto me falta por pedir", global y no de la página actual. */
  actionableCount: number;
  /** Cuántos reportes esperan decisión. */
  reportsCount: number;
};

export function MissingBoardTabs({
  active,
  view,
  actionableCount,
  reportsCount,
}: MissingBoardTabsProps) {
  return (
    <nav
      aria-label="Estado de los faltantes"
      className="flex flex-wrap gap-2 text-sm font-semibold print:hidden"
    >
      {MISSING_SCOPES.map((option) => (
        <Link
          prefetch={false}
          key={option}
          href={missingScopeHref(option, view)}
          aria-current={active === option ? "page" : undefined}
          className={tabClasses(active === option)}
        >
          <span>{MISSING_SCOPE_LABELS[option]}</span>
          {/* Solo la cola de trabajo lleva número: es el único que responde
              "cuánto me falta". En las otras dos sería ruido. */}
          {option === "actionable" ? (
            <span className="tabular-nums">{actionableCount}</span>
          ) : null}
        </Link>
      ))}

      <Link
        prefetch={false}
        href={`?scope=${REPORTS_TAB_SCOPE}`}
        aria-current={active === REPORTS_TAB_SCOPE ? "page" : undefined}
        className={tabClasses(active === REPORTS_TAB_SCOPE)}
      >
        <span>Reportes</span>
        {/* El contador solo aparece cuando hay algo esperando decisión: un "0"
            permanente entrena a no mirar el número. */}
        {reportsCount > 0 ? (
          <span className="tabular-nums">{reportsCount}</span>
        ) : null}
      </Link>
    </nav>
  );
}

import Link from "next/link";

import { SUPPLY_TAB } from "@/features/faltantes/missing-scope";
import {
  REVIEW_TABS,
  REVIEW_TAB_LABELS,
  reviewTabHref,
  type ReviewTab,
} from "@/features/pendientes/review-tab";
import { cn } from "@/lib/utils/cn";

// Las pestañas de nivel superior de Revisión de pendientes. Las reglas del eje
// —qué mitades hay, cómo se leen de la URL y cómo se arma cada enlace— viven en
// `review-tab.ts`; acá solo se pintan.

type ReviewTabsProps = {
  active: ReviewTab;
  /** Cuánto falta por pedir de los pedidos de cliente. */
  supplyCount: number;
};

export function ReviewTabs({ active, supplyCount }: ReviewTabsProps) {
  return (
    <nav
      aria-label="Vista de revisión de pendientes"
      className="flex flex-wrap gap-2 text-sm font-semibold print:hidden"
    >
      {REVIEW_TABS.map((tab) => (
        <Link
          prefetch={false}
          key={tab}
          href={reviewTabHref(tab)}
          aria-current={active === tab ? "page" : undefined}
          // Altura de dedo (44px): se usa desde el celular.
          className={cn(
            "inline-flex min-h-11 items-center gap-2 rounded-lg px-4 transition-colors",
            active === tab
              ? "bg-primary text-primary-foreground"
              : "bg-muted/60 text-muted-foreground hover:bg-muted",
          )}
        >
          <span>{REVIEW_TAB_LABELS[tab]}</span>
          {/* Solo el abastecimiento lleva número: es el que responde "cuánto me
              falta comprar". En seguimiento sería el total de la cola, que no
              pide ninguna acción concreta. */}
          {tab === SUPPLY_TAB && supplyCount > 0 ? (
            <span className="tabular-nums">{supplyCount}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import type { MissingItemsSummary } from "@/server/services/missing-item.service";

type MissingSummaryProps = {
  summary: MissingItemsSummary;
};

// Resumen global de faltantes (server component presentacional, sin fetch
// propio: recibe las métricas ya calculadas). Mobile-first: tarjetas
// apiladas, sm:grid-cols-2. Sigue el lenguaje visual de `admin-overview.tsx`
// (tiles bordeados rounded-xl, bg-muted/30, texto 3xl bold, labels muted).
export function MissingSummary({ summary }: MissingSummaryProps) {
  const hasOverdue = summary.overdue > 0;

  return (
    <section className="space-y-4" aria-labelledby="faltantes-summary-title">
      <Card className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-primary">
              Resumen global
            </p>
            <h2 id="faltantes-summary-title" className="mt-1 text-xl font-bold text-text">
              Faltantes
            </h2>
          </div>
          <Badge tone={hasOverdue ? "danger" : "success"}>
            {hasOverdue ? "Requiere atención" : "Al día"}
          </Badge>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <p className="text-sm text-muted-foreground">Faltantes abiertos</p>
            <p className="mt-1 text-3xl font-bold text-text">{summary.open}</p>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <p className="text-sm text-muted-foreground">
              Vencidos <span className="font-normal">(subconjunto de los abiertos)</span>
            </p>
            <p
              className={`mt-1 text-3xl font-bold ${hasOverdue ? "text-danger" : "text-text"}`}
            >
              {summary.overdue}
            </p>
          </div>
        </div>
      </Card>
    </section>
  );
}

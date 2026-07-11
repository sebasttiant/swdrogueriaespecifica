import { cn } from "@/lib/utils/cn";
import type { MissingItemsSummary } from "@/server/services/missing-item.service";

type MissingSummaryProps = {
  summary: MissingItemsSummary;
};

// Franja compacta de indicadores globales (server component presentacional, sin
// fetch propio).
//
// Antes esto era una tarjeta con tiles de texto 3xl que se comía la mitad de la
// pantalla del celular antes del primer faltante accionable. `/faltantes` es una
// cola operativa, no un tablero: los números orientan, no son el contenido. El
// análisis vive en `/reportes`.
//
// Scrollea horizontal en pantallas angostas en vez de envolver y crecer en alto:
// el alto es justamente lo que hay que proteger.
export function MissingSummary({ summary }: MissingSummaryProps) {
  // `alerts` marca el único chip que exige reacción. Un cero nunca es alarma:
  // pintar "Vencidos: 0" de rojo entrena al operador a ignorar el color.
  const chips = [
    { label: "Abiertos", value: summary.open, alerts: false },
    { label: "Vencidos", value: summary.overdue, alerts: summary.overdue > 0 },
    { label: "Pedidos", value: summary.ordered, alerts: false },
    { label: "OK gerencia", value: summary.confirmed, alerts: false },
  ];

  return (
    <section aria-labelledby="faltantes-summary-title">
      <h2 id="faltantes-summary-title" className="sr-only">
        Resumen global de faltantes
      </h2>

      <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {chips.map((chip) => (
          <li
            key={chip.label}
            className={cn(
              "flex shrink-0 items-baseline gap-1.5 rounded-full border px-3 py-1.5 text-sm",
              chip.alerts
                ? "border-danger/30 bg-danger/10 text-danger"
                : "border-border bg-muted/30 text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "font-bold tabular-nums",
                chip.alerts ? "text-danger" : "text-text",
              )}
            >
              {chip.value}
            </span>
            <span>{chip.label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

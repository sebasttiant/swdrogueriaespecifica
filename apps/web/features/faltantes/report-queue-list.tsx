import Link from "next/link";
import { Inbox } from "lucide-react";

import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { MissingReportQueueGroup } from "@/server/services/missing-report.service";

import { ReportQuickActions } from "./report-quick-actions";
import type { ReportQueueScope } from "./report-queue-scope";
import { reportQueueHref } from "./report-queue-paging";

type ReportQueueListProps = {
  groups: MissingReportQueueGroup[];
  page: number;
  hasMore: boolean;
  // Vista activa: decide qué acciones ofrece cada fila y qué decir cuando no
  // hay nada. Un vacío genérico haría dudar de si la acción se guardó.
  scope: ReportQueueScope;
  emptyTitle: string;
  emptyDescription: string;
};

// "4" / "1": cuenta REPORTES del mismo producto, nunca suma cantidades — un
// reporte no tiene cantidad. Sirve para priorizar: lo que varios vendedores
// anotaron el mismo día es lo que más se está pidiendo en el mostrador.
function timesReported(count: number): string {
  return count === 1 ? "1 reporte" : `${count} reportes`;
}

// --------------------------------------------------------------------------
// Cola de revisión, en formato LISTA.
//
// Antes cada grupo era una tarjeta alta con título, badge, fecha, disclosure y
// dos botones a ancho completo. Con 40 reportes en una hora eso es un scroll
// interminable: gerencia necesita ESCANEAR la lista y marcar, no leer tarjeta
// por tarjeta.
//
// Ahora cada grupo es un renglón: nombre + cuántas veces + cuándo, y las dos
// acciones a la derecha. Cabe una decisión por línea, que es el punto entero.
//
// Vincular al catálogo sobrevive plegado dentro de cada fila: es opcional —el
// gerente dijo que buscar en el catálogo demora demasiado— y solo sirve para
// que el faltante se cierre solo cuando entre la mercadería.
// --------------------------------------------------------------------------
export function ReportQueueList({
  groups,
  page,
  hasMore,
  scope,
  emptyTitle,
  emptyDescription,
}: ReportQueueListProps) {
  if (groups.length === 0) {
    return <EmptyState icon={Inbox} title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="space-y-3">
      <Card className="divide-y divide-border p-0">
        {groups.map((group) => (
          <div key={group.normalizedName} className="space-y-1 px-3 py-2">
            {/* Un renglón por grupo: lo que hay que leer a la izquierda, lo que
                hay que tocar a la derecha. En celular las acciones bajan solas
                sin romper la lectura. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="break-words font-medium text-text">
                  {group.displayName}
                </p>
                <p className="text-xs text-muted-foreground">
                  {timesReported(group.count)}
                  {group.latestReportedAt
                    ? ` · ${formatBogotaDate(group.latestReportedAt, { style: "datetime" })}`
                    : ""}
                </p>
              </div>

              <ReportQuickActions
                normalizedName={group.normalizedName}
                productName={group.displayName}
                scope={scope}
              />
            </div>

            {/* Quién reportó, bajo demanda: un renglón de texto chico, no un
                bloque abierto que empuje la lista fuera de pantalla. */}
            <details className="group text-xs">
              <summary className="inline-flex min-h-11 cursor-pointer list-none items-center text-muted-foreground hover:text-text [&::-webkit-details-marker]:hidden">
                Ver quién lo reportó
              </summary>
              <ul className="mb-2 space-y-2 text-muted-foreground">
                {group.reports.map((report) => (
                  <li key={report.id} className="space-y-0.5">
                    <p className="break-words text-text">{report.rawName}</p>
                    <p>
                      {report.reporter?.name ?? "Reportante no disponible"}
                      {report.sellerCode ? ` · ${report.sellerCode}` : ""} ·{" "}
                      {formatBogotaDate(report.createdAt, { style: "datetime" })}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        ))}
      </Card>

      {/* Paginación por offset: esta cola agrupa con `groupBy`, que no admite
          cursor. Por eso vive en su propia ruta y no comparte URL con la cola
          de faltantes, que sí pagina por cursor. */}
      <nav
        aria-label="Paginación de reportes"
        className="flex items-center justify-between gap-2 pt-1 text-sm"
      >
        {page > 1 ? (
          <Link
            href={reportQueueHref(page - 1, scope)}
            className="inline-flex min-h-11 items-center px-2 font-semibold text-primary hover:underline"
          >
            Anterior
          </Link>
        ) : (
          <span />
        )}

        <span className="text-muted-foreground">Página {page}</span>

        {hasMore ? (
          <Link
            href={reportQueueHref(page + 1, scope)}
            className="inline-flex min-h-11 items-center px-2 font-semibold text-primary hover:underline"
          >
            Siguiente
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </div>
  );
}

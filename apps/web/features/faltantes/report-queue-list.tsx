import Link from "next/link";
import { Inbox } from "lucide-react";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { MissingReportQueueGroup } from "@/server/services/missing-report.service";

import { ReportLinkForm } from "./report-link-form";
import { ReportQuickActions } from "./report-quick-actions";
import { reportQueueHref } from "./report-queue-paging";

type ReportQueueListProps = {
  groups: MissingReportQueueGroup[];
  page: number;
  hasMore: boolean;
};

// "Reportado 4 veces" / "Reportado 1 vez": cuenta REPORTES, nunca suma
// cantidades — un reporte no tiene cantidad.
function timesReported(count: number): string {
  return count === 1 ? "Reportado 1 vez" : `Reportado ${count} veces`;
}

// Cola de revisión de gerencia, SOLO LECTURA. Cada tarjeta es un producto (por
// su nombre) que uno o varios vendedores reportaron como faltante. Se muestra el
// nombre ORIGINAL —tal como lo pegaron desde Orión—; el nombre normalizado es
// interno y solo sirve para agrupar, así que no aparece en pantalla.
//
// Mobile-first: una columna, tarjetas compactas, y el historial individual
// colapsado detrás de un disclosure (mismo patrón que la cola de faltantes) para
// que la pantalla del celular muestre varios grupos sin scroll infinito.
//
// Tres salidas, en orden de uso real: "Ya lo pedí" y "Descartar" resuelven el
// grupo en un toque, y vincularlo a un producto del catálogo queda colapsado
// debajo para cuando además se quiere seguimiento de stock.
//
// Vincular era antes la ÚNICA salida, y por eso la cola solo crecía: si el
// producto que el vendedor pegó desde Orión no estaba en el catálogo, el reporte
// quedaba atrapado sin forma de sacarlo. Ese era el reclamo de gerencia.
export function ReportQueueList({ groups, page, hasMore }: ReportQueueListProps) {
  if (groups.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No hay reportes pendientes"
        description="Cuando un vendedor reporte un producto faltante, aparecerá acá para revisión."
      />
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <Card key={group.normalizedName} className="space-y-2 p-4">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 break-words text-base font-semibold text-text">
              {group.displayName}
            </p>
            <Badge tone="warning" className="shrink-0">
              {timesReported(group.count)}
            </Badge>
          </div>

          {group.latestReportedAt ? (
            <p className="text-xs text-muted-foreground">
              Último reporte: {formatBogotaDate(group.latestReportedAt, { style: "datetime" })}
            </p>
          ) : null}

          <details className="group">
            {/* `list-none` no alcanza en WebKit: iOS Safari dibuja el triángulo
                con `::-webkit-details-marker`. El padding además da un target
                táctil usable con una mano. */}
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center text-xs font-medium text-muted-foreground hover:text-text [&::-webkit-details-marker]:hidden">
              Ver quién lo reportó
            </summary>
            <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
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

          {/* Las dos salidas rápidas van PRIMERO: son el 95% de las decisiones.
              Vincular al catálogo queda debajo, para cuando gerencia quiere
              además seguimiento de stock del producto. Los tres forms llevan los
              ids de ESTE grupo: la decisión es del grupo entero, nunca de un
              reporte suelto. La página ya exige `canReviewMissingReports`. */}
          <ReportQuickActions
            reportIds={group.reports.map((report) => report.id)}
            productName={group.displayName}
          />

          <details className="group">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center text-xs font-medium text-muted-foreground hover:text-text [&::-webkit-details-marker]:hidden">
              Vincular a un producto del catálogo
            </summary>
            <div className="mt-2">
              <ReportLinkForm reportIds={group.reports.map((report) => report.id)} />
            </div>
          </details>
        </Card>
      ))}

      {/* Paginación por offset: esta cola agrupa con `groupBy`, que no admite
          cursor. Por eso vive en su propia ruta y no comparte URL con la cola
          de faltantes, que sí pagina por cursor. */}
      <nav
        aria-label="Paginación de reportes"
        className="flex items-center justify-between gap-2 pt-1 text-sm"
      >
        {page > 1 ? (
          <Link
            href={reportQueueHref(page - 1)}
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
            href={reportQueueHref(page + 1)}
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

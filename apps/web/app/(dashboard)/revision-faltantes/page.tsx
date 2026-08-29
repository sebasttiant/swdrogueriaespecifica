import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { ReportQueueList } from "@/features/faltantes/report-queue-list";
import { parseReportQueuePage } from "@/features/faltantes/report-queue-paging";
import {
  REPORT_QUEUE_SCOPES,
  REPORT_QUEUE_SCOPE_EMPTY,
  REPORT_QUEUE_SCOPE_LABELS,
  reportQueueScopeHref,
  resolveReportQueueScope,
} from "@/features/faltantes/report-queue-scope";
import {
  MissingBoardTabs,
  REPORTS_TAB_SCOPE,
} from "@/features/faltantes/missing-board-tabs";
import { MissingQueueBoard } from "@/features/faltantes/missing-queue-board";
import {
  SHELF_BOARD_ROUTE,
  repositoryScopeFor,
  resolveMissingScope,
} from "@/features/faltantes/missing-scope";
import { resolveMissingView } from "@/features/faltantes/missing-view";
import {
  getActionableMissingCount,
  getMissingItems,
} from "@/server/services/missing-item.service";
import { can } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import { cn } from "@/lib/utils/cn";
import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import { getMissingReportQueue } from "@/server/services/missing-report.service";

export const metadata: Metadata = { title: "Revisión de faltantes" };

// Cola operativa en vivo: nunca cachear.
export const dynamic = "force-dynamic";

// Cola de revisión de los faltantes que reportan los vendedores.
//
// Vive en su propia ruta, separada de `/faltantes`, porque las dos colas
// paginan distinto (cursor allá, offset acá). Pero se COMPORTAN igual: mismas
// tres pestañas, mismas palabras y el mismo gesto de un toque. Quien las usa
// tiene 60 años; que se parezcan es lo que evita tener que aprender dos cosas.
//
// El nav ya oculta el link a quien no puede revisar; este guard protege el
// acceso directo a la ruta.
export default async function RevisionFaltantesPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    scope?: string;
    view?: string;
    cursor?: string;
    /** Estado dentro del buzón de reportes, para no pisar `scope`. */
    rscope?: string;
  }>;
}) {
  // UNA proyección y una sola: la mesa de trabajo de GERENCIA.
  //
  // Bodega tenía acá su cola de recepción, y el nombre le mentía: no revisa
  // faltantes, recibe mercadería —y encima marcaba la llegada del pedido de un
  // cliente dentro de un módulo de estantería—. Se mudó a `/recepcion`, con su
  // propio nombre y las dos colas juntas.
  const session = await requireCapability("canReviewMissingReports");

  const {
    page: rawPage,
    scope: rawScope,
    view: rawView,
    cursor: rawCursor,
    rscope: rawReportScope,
  } = await searchParams;

  // --------------------------------------------------------------------------
  // Esta pantalla es ESTRICTAMENTE DE ESTANTERÍA.
  //
  // Un faltante que nació de un pendiente NO es una reposición: es el pedido de
  // un cliente concreto, con fecha prometida y a veces con abono entregado. Se
  // compra desde Revisión de PENDIENTES, que es donde el gerente tiene delante
  // a quién está esperando.
  //
  // Bodega no queda afuera de nada: recibe los DOS orígenes en `/recepcion`,
  // que es una cola de bultos físicos y no de decisiones de compra.
  // --------------------------------------------------------------------------
  const SHELF_ONLY = "shelf" as const;

  // El buzón de reportes es UNA PESTAÑA, no una pantalla aparte. Es un modelo
  // distinto (`MissingReport`), pero aprobar un reporte es lo que CREA un
  // faltante: es la puerta de entrada a esta misma cola.
  const showingReports = rawScope === REPORTS_TAB_SCOPE;
  const view = resolveMissingView(rawView);
  const scope = resolveMissingScope(rawScope);

  const canAct = can(session.user.role, "canOrderMissingItems");
  const canViewCustomerIdentity = can(session.user.role, "canViewCustomerIdentity");
  const canViewSupplierIdentity = can(session.user.role, "canViewSupplierIdentity");
  const canExport = can(session.user.role, "canExportFaltantes");

  const now = new Date();
  const page = parseReportQueuePage(rawPage);
  const reportScope = resolveReportQueueScope(rawReportScope);

  // Las dos consultas van SIEMPRE: la de la cola alimenta la pestaña activa y
  // la del buzón alimenta su contador. Un contador que solo se calcula al
  // entrar a la pestaña no avisa de nada, que es justo lo que tiene que hacer.
  const [queue, actionableCount, reports] = await Promise.all([
    showingReports
      ? Promise.resolve(null)
      : getMissingItems({
          cursor: rawCursor,
          scope: repositoryScopeFor(scope),
          origin: SHELF_ONLY,
          canViewCustomerIdentity,
          canViewSupplierIdentity,
        }),
    // El contador de "Por pedir" tiene que contar LO QUE ESTA PANTALLA MUESTRA.
    // Global, marcaría trabajo que acá no se puede tocar.
    getActionableMissingCount(SHELF_ONLY),
    getMissingReportQueue({
      page,
      pageSize: DEFAULT_PAGE_SIZE,
      scope: showingReports ? reportScope : "pending",
    }),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Revisión de faltantes"
        description="Decidí qué pedir y qué descartar. Bodega marca acá lo que llega."
      />

      <MissingBoardTabs
        active={showingReports ? REPORTS_TAB_SCOPE : scope}
        view={view}
        actionableCount={actionableCount}
        reportsCount={reports.groups.length}
        route={SHELF_BOARD_ROUTE}
        label="Estado de los faltantes"
      />

      {showingReports ? (
        <>
          {/* Sub-pestañas del buzón. Van adentro de "Reportes" y no arriba,
              porque describen el estado de un reporte, no el de un faltante:
              subirlas volvería a mezclar los dos modelos en una sola fila, que
              es lo que hacía parecer que había dos tableros iguales. */}
          <nav
            aria-label="Estado de los reportes"
            className="flex flex-wrap gap-2 text-sm font-semibold"
          >
            {REPORT_QUEUE_SCOPES.map((option) => (
              <Link
                prefetch={false}
                key={option}
                href={`${reportQueueScopeHref(option)}&scope=${REPORTS_TAB_SCOPE}`}
                aria-current={reportScope === option ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-lg px-4 transition-colors",
                  reportScope === option
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/60 text-muted-foreground hover:bg-muted",
                )}
              >
                {REPORT_QUEUE_SCOPE_LABELS[option]}
              </Link>
            ))}
          </nav>

          <ReportQueueList
            groups={reports.groups}
            page={page}
            hasMore={reports.hasMore}
            scope={reportScope}
            emptyTitle={REPORT_QUEUE_SCOPE_EMPTY[reportScope].title}
            emptyDescription={REPORT_QUEUE_SCOPE_EMPTY[reportScope].description}
          />
        </>
      ) : (
        <MissingQueueBoard
          items={queue!.items}
          nextCursor={queue!.nextCursor}
          scope={scope}
          view={view}
          canAct={canAct}
          canExport={canExport}
          canSeeSupplier={canViewSupplierIdentity}
          now={now}
          route={SHELF_BOARD_ROUTE}
          label="Vista de faltantes"
        />
      )}
    </div>
  );
}

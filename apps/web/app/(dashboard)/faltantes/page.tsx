import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card, CardTitle } from "@/app/_components/ui/card";
import {
  MissingCreateForm,
} from "@/features/faltantes/missing-create-form";
import { MissingExportActions } from "@/features/faltantes/missing-export-actions";
import { MissingBulkActions } from "@/features/faltantes/missing-bulk-actions";
import { MissingList } from "@/features/faltantes/missing-list";
import { MissingListCompact } from "@/features/faltantes/missing-list-compact";
import { MissingReportForm } from "@/features/faltantes/missing-report-form";
import { MyMissingReports } from "@/features/faltantes/my-missing-reports";
import { REVIEW_QUEUE_PATH } from "@/features/faltantes/report-queue-paging";
import { MissingSummary } from "@/features/faltantes/missing-summary";
import { canDiscard } from "@/features/faltantes/order-rules";
import {
  MISSING_SCOPES,
  MISSING_SCOPE_EMPTY,
  MISSING_SCOPE_LABELS,
  missingPageHref,
  missingScopeHref,
  repositoryScopeFor,
  resolveMissingScope,
} from "@/features/faltantes/missing-scope";
import { resolveMissingView } from "@/features/faltantes/missing-view";
import { can } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils/cn";
import { requireCapability } from "@/lib/auth/require-role";
import {
  getActionableMissingCount,
  getMissingItems,
  getMissingItemsSummary,
} from "@/server/services/missing-item.service";
import { getMyMissingReports } from "@/server/services/missing-report.service";

export const metadata: Metadata = { title: "Faltantes" };

export default async function FaltantesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; view?: string; scope?: string }>;
}) {
	const { cursor, view: rawView, scope: rawScope } = await searchParams;
	const view = resolveMissingView(rawView);
	const scope = resolveMissingScope(rawScope);
	const session = await requireCapability("canViewFaltantes");
	const canOrderMissingItems = can(session.user.role, "canOrderMissingItems");
	const canCreateMissingItems = can(session.user.role, "canCreateMissingItems");
	const canSubmitMissingReports = can(session.user.role, "canSubmitMissingReports");
	const canReviewMissingReports = can(session.user.role, "canReviewMissingReports");
	const canViewCustomerIdentity = can(session.user.role, "canViewCustomerIdentity");
	// De quién compra la droguería: solo gerencia. El service ya lo minimiza,
	// así que esto último solo evita renderizar una columna que vendría vacía.
	const canViewSupplierIdentity = can(session.user.role, "canViewSupplierIdentity");
	// Descargar la cola a un archivo: solo gerencia. El vendedor ve la cola pero
	// no se la lleva.
	const canExportFaltantes = can(session.user.role, "canExportFaltantes");

  // Un único instante compartido por el resumen global y el agrupamiento de
  // la página actual, para que ambos hablen del mismo "ahora".
  const now = new Date();
  const [{ items, nextCursor }, summary, actionableCount, myReports] = await Promise.all([
    getMissingItems({
      cursor,
      scope: repositoryScopeFor(scope),
      canViewCustomerIdentity,
      canViewSupplierIdentity,
    }),
    getMissingItemsSummary(now),
    // Global, no de la página actual: es "cuánto me falta por pedir".
    getActionableMissingCount(),
    canSubmitMissingReports ? getMyMissingReports(session.user.id) : Promise.resolve([]),
  ]);

  // Orden deliberado y compacto: título → chips → cola. Todo lo que se
  // interponga entre abrir la página y tocar una acción es peso muerto en el
  // celular del gerente. El análisis vive en `/reportes`.
  return (
    <div className="space-y-4">
      <PageHeader title="Faltantes" description="Lo que hay que conseguir." />

      <MissingSummary summary={summary} />

      {/* Atajo de gerencia a la cola de revisión. Link plano a propósito:
          un contador obligaría a una consulta extra en cada carga de esta
          pantalla, que es la del vendedor en el celular. */}
      {canReviewMissingReports ? (
        <Link
          href={REVIEW_QUEUE_PATH}
          className="inline-block text-sm font-semibold text-primary hover:underline print:hidden"
        >
          Revisar reportes de vendedores
        </Link>
      ) : null}

      {/* Reporte del vendedor: pegar un nombre desde Orión y avisar que falta.
          Es un eje aparte del alta catalogada de gerencia (abajo): distinto
          permiso, distinta tarjeta, distinto texto. Un OPERADOR ve esto y NADA
          del flujo administrativo. */}
      {canSubmitMissingReports ? (
        <Card className="space-y-3 p-3 print:hidden">
          <CardTitle>Reportar faltante</CardTitle>
          <MissingReportForm />
        </Card>
      ) : null}

      {canSubmitMissingReports ? <MyMissingReports reports={myReports} /> : null}

      {canCreateMissingItems ? (
        <Card className="space-y-3 p-3 print:hidden">
          <CardTitle>Alta manual catalogada</CardTitle>
          <MissingCreateForm />
        </Card>
      ) : null}

      {/* Pestañas por estado. Son el corazón del pedido de gerencia: la cola
          muestra SOLO lo que falta por pedir, y lo resuelto se consulta acá al
          lado sin haberse borrado. Altura de dedo (44px) porque se usan desde
          el celular. */}
      <nav
        aria-label="Estado de los faltantes"
        className="flex flex-wrap gap-2 text-sm font-semibold print:hidden"
      >
        {MISSING_SCOPES.map((option) => (
          <Link
            key={option}
            href={missingScopeHref(option, view)}
            aria-current={scope === option ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center gap-2 rounded-lg px-4 transition-colors",
              scope === option
                ? "bg-primary text-primary-foreground"
                : "bg-muted/60 text-muted-foreground hover:bg-muted",
            )}
          >
            <span>{MISSING_SCOPE_LABELS[option]}</span>
            {/* Solo la cola de trabajo lleva número: es el único que responde
                "cuánto me falta". En las otras dos sería ruido. */}
            {option === "actionable" ? (
              <span className="tabular-nums">{actionableCount}</span>
            ) : null}
          </Link>
        ))}
      </nav>

      {/* Toggle de vista (completa/compacta) + export. Se ocultan al imprimir:
          el PDF es la lista, no los controles. */}
      <div className="flex flex-col gap-3 print:hidden sm:flex-row sm:items-center sm:justify-between">
        <nav aria-label="Vista de faltantes" className="flex gap-2 text-sm font-semibold">
          <Link
            href={missingScopeHref(scope, "full")}
            aria-current={view === "full" ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-1.5 transition-colors",
              view === "full"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            Completa
          </Link>
          <Link
            href={missingScopeHref(scope, "compact")}
            aria-current={view === "compact" ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-1.5 transition-colors",
              view === "compact"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            Compacta
          </Link>
        </nav>

        {/* Export (Excel/CSV/PDF) solo para gerencia. La ruta de descarga
            revalida la capacidad igual: esto solo evita ofrecer el botón. */}
        {canExportFaltantes ? <MissingExportActions /> : null}
      </div>

      {/* Cierre rápido de duplicados: solo la autoridad de compras. El vendedor
          no ve ni las casillas. Se ofrecen únicamente los faltantes que la
          acción admite, para no mostrar un control que el servidor rechazaría. */}
      {canOrderMissingItems ? (
        <MissingBulkActions
          items={items
            .filter((item) => canDiscard(item.status))
            .map((item) => ({
              id: item.id,
              productName: item.product.name,
              quantity: item.originId ? item.quantity : null,
              unit: item.product.unit,
              sellerCode: item.originId ? null : item.sellerCode,
            }))}
        />
      ) : null}

      {view === "compact" ? (
        <MissingListCompact
          items={items}
          canAct={canOrderMissingItems}
          emptyTitle={MISSING_SCOPE_EMPTY[scope].title}
          emptyDescription={MISSING_SCOPE_EMPTY[scope].description}
          nextCursor={nextCursor}
          pageHref={(next) => missingPageHref(scope, view, next)}
        />
      ) : (
        <MissingList
          items={items}
          nextCursor={nextCursor}
          pageHref={(next) => missingPageHref(scope, view, next)}
          canQuickAct={canOrderMissingItems}
          canSeeStatus={canOrderMissingItems}
          canSeeSupplier={canViewSupplierIdentity}
          now={now}
        />
      )}
    </div>
  );
}

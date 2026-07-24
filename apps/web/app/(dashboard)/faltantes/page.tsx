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
import { REVIEW_QUEUE_PATH } from "@/features/faltantes/report-queue-paging";
import { MissingSummary } from "@/features/faltantes/missing-summary";
import {
  canDiscard,
  canShowNewSupplierOrderForm,
  canShowOrderForm,
} from "@/features/faltantes/order-rules";
import { resolveMissingView } from "@/features/faltantes/missing-view";
import { can } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils/cn";
import { requireCapability } from "@/lib/auth/require-role";
import {
  getMissingItems,
  getMissingItemsSummary,
} from "@/server/services/missing-item.service";
import { getSuppliers } from "@/server/services/supplier.service";

export const metadata: Metadata = { title: "Faltantes" };

export default async function FaltantesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; view?: string }>;
}) {
	const { cursor, view: rawView } = await searchParams;
	const view = resolveMissingView(rawView);
	const session = await requireCapability("canViewFaltantes");
	const canOrderMissingItems = can(session.user.role, "canOrderMissingItems");
	const canManageSuppliers = can(session.user.role, "canManageSuppliers");
	const canCreateMissingItems = can(session.user.role, "canCreateMissingItems");
	const canSubmitMissingReports = can(session.user.role, "canSubmitMissingReports");
	const canReviewMissingReports = can(session.user.role, "canReviewMissingReports");
	const canViewCustomerIdentity = can(session.user.role, "canViewCustomerIdentity");
	// De quién compra la droguería: solo gerencia. El service ya lo minimiza,
	// así que esto último solo evita renderizar una columna que vendría vacía.
	const canViewSupplierIdentity = can(session.user.role, "canViewSupplierIdentity");

  // Un único instante compartido por el resumen global y el agrupamiento de
  // la página actual, para que ambos hablen del mismo "ahora".
  const now = new Date();
  const [{ items, nextCursor }, summary, suppliers] = await Promise.all([
    getMissingItems({ cursor, canViewCustomerIdentity, canViewSupplierIdentity }),
    getMissingItemsSummary(now),
    // Los proveedores alimentan el selector del pedido. Se piden siempre que el
    // usuario pueda pedir: sin la lista no se puede resolver si hay una rama
    // "proveedor existente" disponible.
    canOrderMissingItems ? getSuppliers() : Promise.resolve([]),
  ]);

  // Pedir a un proveedor EXISTENTE solo exige `canOrderMissingItems`. Crear uno
  // nuevo exige además `canManageSuppliers`. El formulario se ofrece si alguna de
  // las dos ramas es posible; la Server Action revalida ambas del lado del server.
  const canCreateSupplier = canShowNewSupplierOrderForm({
    canOrderMissingItems,
    canManageSuppliers,
  });
  const canOrder = canShowOrderForm({
    canOrderMissingItems,
    canManageSuppliers,
    hasSuppliers: suppliers.length > 0,
  });

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

      {canCreateMissingItems ? (
        <Card className="space-y-3 p-3 print:hidden">
          <CardTitle>Alta manual catalogada</CardTitle>
          <MissingCreateForm />
        </Card>
      ) : null}

      {/* Toggle de vista (completa/compacta) + export. Se ocultan al imprimir:
          el PDF es la lista, no los controles. */}
      <div className="flex flex-col gap-3 print:hidden sm:flex-row sm:items-center sm:justify-between">
        <nav aria-label="Vista de faltantes" className="flex gap-2 text-sm font-semibold">
          <Link
            href="/faltantes"
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
            href="/faltantes?view=compact"
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

        <MissingExportActions />
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
              quantity: item.quantity,
              unit: item.product.unit,
            }))}
        />
      ) : null}

      {view === "compact" ? (
        <MissingListCompact items={items} />
      ) : (
        <MissingList
          items={items}
          nextCursor={nextCursor}
          canOrder={canOrder}
          canSeeStatus={canOrderMissingItems}
          canSeeSupplier={canViewSupplierIdentity}
          suppliers={suppliers}
          canCreateSupplier={canCreateSupplier}
          now={now}
        />
      )}
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { can } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { MAX_PAGE_SIZE } from "@/lib/pagination";
import { cn } from "@/lib/utils/cn";
import type { PendingScope } from "@/server/repositories/pending.repository";
import {
  PendingForm,
  type ProductOption,
} from "@/features/pendientes/pending-form";
import { PendingCompactList } from "@/features/pendientes/pending-compact-list";
import { PendingList } from "@/features/pendientes/pending-list";
import { getProducts } from "@/server/services/product.service";
import { getPendings, getUsedZones } from "@/server/services/pending.service";

export const metadata: Metadata = { title: "Pendientes" };

export default async function PendientesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; scope?: string; view?: string }>;
}) {
  const session = await requireCapability("canViewPendientes");
  const canViewCustomerIdentity = can(session.user.role, "canViewCustomerIdentity");
  const canDeliver = can(session.user.role, "canDeliverPendings");
  const canCancel = can(session.user.role, "canCancelPendings");
  // Estado de gestión: autoridad de compras (gerencia). Reusa la misma
  // capability que pedir un faltante, no la de cancelar.
  const canManageStatus = can(session.user.role, "canOrderMissingItems");

  const { cursor, scope: rawScope, view: rawView } = await searchParams;

  // Vista LISTADO: la que pidió gerencia para comprar. Eje aparte del scope
  // (abiertos/historial); cualquier valor que no sea "lista" cae en la vista
  // detallada de siempre, que es la del vendedor.
  const view = rawView === "lista" ? "lista" : "detalle";

  // El scope viene de la URL: cualquier valor que no sea exactamente "history"
  // cae en la vista operativa. Un `?scope=cualquier-cosa` no abre los cerrados.
  const scope: PendingScope = rawScope === "history" ? "history" : "active";

  // Opciones para el selector del formulario. Slice MVP: primera página de
  // productos activos (ver README — selector sin búsqueda todavía).
  const [products, pendings, zones] = await Promise.all([
    getProducts({ take: MAX_PAGE_SIZE }),
    getPendings({ cursor, scope, canViewCustomerIdentity }),
    getUsedZones(),
  ]);

  const productOptions: ProductOption[] = products.items
    .filter((product) => product.active)
    .map((product) => ({
      id: product.id,
      name: product.name,
      code: product.code,
    }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pendientes"
        description="Solicitudes de clientes. Si no hay stock suficiente, se genera un faltante automático."
      />

      <Card className="space-y-4">
        <CardTitle>Nuevo pendiente</CardTitle>
        <PendingForm products={productOptions} zones={zones} />
      </Card>

      {/* El historial es una vista aparte: los cerrados no se mezclan con lo que
          todavía hay que atender. Cambiar de scope vuelve a la primera página,
          porque el cursor de una vista no es válido en la otra. */}
      <nav aria-label="Vista de pendientes" className="flex gap-2 text-sm font-semibold">
        <Link
          href={view === "lista" ? "/pendientes?view=lista" : "/pendientes"}
          aria-current={scope === "active" ? "page" : undefined}
          className={cn(
            "rounded-lg px-3 py-1.5 transition-colors",
            scope === "active"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
        >
          Abiertos
        </Link>
        <Link
          href={view === "lista" ? "/pendientes?scope=history&view=lista" : "/pendientes?scope=history"}
          aria-current={scope === "history" ? "page" : undefined}
          className={cn(
            "rounded-lg px-3 py-1.5 transition-colors",
            scope === "history"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
        >
          Historial
        </Link>
      </nav>

      {/* Detalle vs Listado. "Detalle" es la vista del vendedor —cliente,
          teléfono, dirección, abonos—; "Listado" es la de compras, con lo
          mínimo para decidir qué conseguir. El gerente pidió explícitamente
          esta segunda: "que lo muestre en listado... un listadito". */}
      <nav aria-label="Formato de la lista" className="flex gap-2 text-sm font-semibold">
        <Link
          href={scope === "history" ? "/pendientes?scope=history" : "/pendientes"}
          aria-current={view === "detalle" ? "page" : undefined}
          className={cn(
            "inline-flex min-h-11 items-center rounded-lg px-4 transition-colors",
            view === "detalle"
              ? "bg-primary text-primary-foreground"
              : "bg-muted/60 text-muted-foreground hover:bg-muted",
          )}
        >
          Detalle
        </Link>
        <Link
          href={
            scope === "history"
              ? "/pendientes?scope=history&view=lista"
              : "/pendientes?view=lista"
          }
          aria-current={view === "lista" ? "page" : undefined}
          className={cn(
            "inline-flex min-h-11 items-center rounded-lg px-4 transition-colors",
            view === "lista"
              ? "bg-primary text-primary-foreground"
              : "bg-muted/60 text-muted-foreground hover:bg-muted",
          )}
        >
          Listado
        </Link>
      </nav>

      {view === "lista" ? (
        <PendingCompactList
          items={pendings.items}
          canOrder={canManageStatus}
          nextCursor={pendings.nextCursor}
          pageHref={(nextCursor) =>
            `/pendientes?cursor=${encodeURIComponent(nextCursor)}&view=lista${
              scope === "history" ? "&scope=history" : ""
            }`
          }
        />
      ) : (
        <PendingList
          items={pendings.items}
          nextCursor={pendings.nextCursor}
          canDeliver={canDeliver}
          canCancel={canCancel}
          canManageStatus={canManageStatus}
          scope={scope}
        />
      )}
    </div>
  );
}

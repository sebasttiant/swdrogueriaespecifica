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
import { PendingReviewFilters } from "@/features/pendientes/pending-review-filters";
import {
  parseReviewAxes,
  reviewHref,
  reviewPageHref,
} from "@/features/pendientes/review-axes";
import { getProducts } from "@/server/services/product.service";
import { getPendings, getUsedZones } from "@/server/services/pending.service";

export const metadata: Metadata = { title: "Pendientes" };

export default async function PendientesPage({
  searchParams,
}: {
  searchParams: Promise<{
    cursor?: string;
    scope?: string;
    view?: string;
    purchase?: string;
    availability?: string;
    customer?: string;
  }>;
}) {
  const session = await requireCapability("canViewPendientes");
  const canManageAll = can(session.user.role, "canManageAllPendings");
  // Quien no gestiona todo recibe la lista acotada a sus propias filas (abajo,
  // vía `ownerId`), así que ve los datos de SUS clientes: son los que tiene que
  // llamar. Ver los de todos es lo que exige la capacidad.
  const canViewCustomerIdentity = canManageAll
    ? can(session.user.role, "canViewCustomerIdentity")
    : true;
  const canDeliver = can(session.user.role, "canDeliverPendings");
  const canCancel = can(session.user.role, "canCancelPendings");
  const canContactOrInvoice = can(session.user.role, "canContactOwnPendings") || can(session.user.role, "canInvoiceOwnPendings");
  // Estado de gestión: autoridad de compras (gerencia). Reusa la misma
  // capability que pedir un faltante, no la de cancelar.
  const canManageStatus = can(session.user.role, "canOrderMissingItems");

  const { cursor, scope: rawScope, view: rawView, ...rawAxes } = await searchParams;

  // Los ejes salen de la URL con la misma desconfianza que el scope: un valor
  // que no está en el enum se descarta y equivale a no filtrar. Estos strings
  // terminan en una consulta contra enums de PostgreSQL.
  const axes = parseReviewAxes(rawAxes);

  // LISTADO por defecto: es la vista que pidió gerencia y la que se lee de un
  // vistazo con decenas de pendientes por hora. El detalle —cliente, teléfono,
  // dirección, abonos, entrega— queda a un toque para quien lo necesite.
  const view = rawView === "detalle" ? "detalle" : "lista";

  // El scope viene de la URL: cualquier valor que no sea exactamente "history"
  // cae en la vista operativa. Un `?scope=cualquier-cosa` no abre los cerrados.
  const scope: PendingScope = rawScope === "history" ? "history" : "active";

  // Opciones para el selector del formulario. Slice MVP: primera página de
  // productos activos (ver README — selector sin búsqueda todavía).
  const [products, pendings, zones] = await Promise.all([
    getProducts({ take: MAX_PAGE_SIZE }),
    getPendings({
      cursor,
      scope,
      axes,
      canViewCustomerIdentity,
      ownerId: canManageAll ? undefined : session.user.id,
    }),
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
          href={reviewHref({ scope: "active", view, axes })}
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
          href={reviewHref({ scope: "history", view, axes })}
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

      {/* Revisión por ejes: acotan QUÉ se lista. Quién ve qué no se toca acá —
          eso ya lo resolvieron la capacidad y el `ownerId` de arriba. */}
      <PendingReviewFilters axes={axes} scope={scope} view={view} />

      {/* Listado PRIMERO: es la vista con la que se trabaja —producto,
          cantidad, vendedor, estado y la acción— y por eso va antes. "Detalle"
          queda segundo, para cuando hace falta el cliente, el teléfono, la
          dirección o los abonos. */}
      <nav aria-label="Formato de la lista" className="flex gap-2 text-sm font-semibold">
        <Link
          href={reviewHref({ scope, view: "lista", axes })}
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
        <Link
          href={reviewHref({ scope, view: "detalle", axes })}
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
      </nav>

      {view === "lista" ? (
        <PendingCompactList
          items={pendings.items}
          canOrder={canManageStatus}
          canDeliver={canDeliver}
          canContactOrInvoice={canContactOrInvoice}
          canCancel={canCancel}
          // Corregir: gerencia sobre cualquiera, el vendedor sobre el suyo y una
          // sola vez. El cupo del vendedor lo hace cumplir el servidor; acá solo
          // se ofrece el enlace a quien puede llegar a usarlo.
          canEdit={canManageAll || can(session.user.role, "canCreatePendientes")}
          canManageAll={canManageAll}
          // Seguimiento y trazabilidad: quien gestiona TODOS los pendientes
          // supervisa la jornada, y para eso tiene que VERLA completa —cliente,
          // zona, saldo y la nota del vendedor— sobre la misma fila. El
          // vendedor no lo necesita: sus filas son suyas y ya las conoce.
          canFollowUp={canManageAll && canViewCustomerIdentity}
          nextCursor={pendings.nextCursor}
          pageHref={(nextCursor) =>
            reviewPageHref({ scope, view: "lista", axes, cursor: nextCursor })
          }
        />
      ) : (
        <PendingList
          items={pendings.items}
          nextCursor={pendings.nextCursor}
          canDeliver={canDeliver}
          canCancel={canCancel}
          canManageStatus={canManageStatus}
          canContactOrInvoice={canContactOrInvoice}
          scope={scope}
          pageHref={(nextCursor) =>
            reviewPageHref({ scope, view: "detalle", axes, cursor: nextCursor })
          }
        />
      )}
    </div>
  );
}

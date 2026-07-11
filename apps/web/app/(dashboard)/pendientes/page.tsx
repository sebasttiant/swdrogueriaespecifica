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
import { PendingList } from "@/features/pendientes/pending-list";
import { getProducts } from "@/server/services/product.service";
import { getPendings } from "@/server/services/pending.service";

export const metadata: Metadata = { title: "Pendientes" };

export default async function PendientesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; scope?: string }>;
}) {
  const session = await requireCapability("canViewPendientes");
  const canViewCustomerIdentity = can(session.user.role, "canViewCustomerIdentity");
  const canDeliver = can(session.user.role, "canDeliverPendings");
  const canCancel = can(session.user.role, "canCancelPendings");

  const { cursor, scope: rawScope } = await searchParams;

  // El scope viene de la URL: cualquier valor que no sea exactamente "history"
  // cae en la vista operativa. Un `?scope=cualquier-cosa` no abre los cerrados.
  const scope: PendingScope = rawScope === "history" ? "history" : "active";

  // Opciones para el selector del formulario. Slice MVP: primera página de
  // productos activos (ver README — selector sin búsqueda todavía).
  const [products, pendings] = await Promise.all([
    getProducts({ take: MAX_PAGE_SIZE }),
    getPendings({ cursor, scope, canViewCustomerIdentity }),
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
        <PendingForm products={productOptions} />
      </Card>

      {/* El historial es una vista aparte: los cerrados no se mezclan con lo que
          todavía hay que atender. Cambiar de scope vuelve a la primera página,
          porque el cursor de una vista no es válido en la otra. */}
      <nav aria-label="Vista de pendientes" className="flex gap-2 text-sm font-semibold">
        <Link
          href="/pendientes"
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
          href="/pendientes?scope=history"
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

      <PendingList
        items={pendings.items}
        nextCursor={pendings.nextCursor}
        canDeliver={canDeliver}
        canCancel={canCancel}
        scope={scope}
      />
    </div>
  );
}

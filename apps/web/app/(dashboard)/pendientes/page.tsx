import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { can } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { MAX_PAGE_SIZE } from "@/lib/pagination";
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
  searchParams: Promise<{ cursor?: string }>;
}) {
  const session = await requireCapability("canViewPendientes");
  const canViewCustomerIdentity = can(session.user.role, "canViewCustomerIdentity");
  const canDeliver = can(session.user.role, "canDeliverPendings");
  const canCancel = can(session.user.role, "canCancelPendings");

  const { cursor } = await searchParams;

  // Opciones para el selector del formulario. Slice MVP: primera página de
  // productos activos (ver README — selector sin búsqueda todavía).
  const [products, pendings] = await Promise.all([
    getProducts({ take: MAX_PAGE_SIZE }),
    getPendings({ cursor, canViewCustomerIdentity }),
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

      <PendingList
        items={pendings.items}
        nextCursor={pendings.nextCursor}
        canDeliver={canDeliver}
        canCancel={canCancel}
      />
    </div>
  );
}

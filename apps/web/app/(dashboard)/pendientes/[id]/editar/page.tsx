import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card } from "@/app/_components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import { MAX_PAGE_SIZE } from "@/lib/pagination";
import { PendingEditForm } from "@/features/pendientes/pending-edit-form";
import type { ProductOption } from "@/features/pendientes/pending-form";
import { getProducts } from "@/server/services/product.service";
import { getPendingForEdit, getUsedZones } from "@/server/services/pending.service";

export const metadata: Metadata = { title: "Corregir pendiente" };

// --------------------------------------------------------------------------
// Corrección de un pendiente, en su propia pantalla.
//
// Fuera del listado a propósito: el listado se lee de un vistazo con decenas de
// filas, y meterle un formulario adentro lo rompería justamente para quien más
// lo usa. Corregir es una excepción, no el trabajo de todos los días.
//
// Quien no puede corregirlo recibe un 404, igual que si no existiera: decirle
// "no es tuyo" le confirmaría que el pendiente existe.
// --------------------------------------------------------------------------
export default async function EditarPendientePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireCapability("canCreatePendientes");
  const canManageAll = can(session.user.role, "canManageAllPendings");
  const { id } = await params;

  const pending = await getPendingForEdit({
    id,
    actorId: session.user.id,
    canManageAll,
  });
  if (!pending) notFound();
  // T2.2b: el cierre parcial es terminal — corregir un pedido que el cliente ya
  // cerró en el mostrador no tiene sentido (el server lo rechaza igual).
  if (
    pending.status === "ENTREGADO" ||
    pending.status === "CANCELADO" ||
    pending.status === "CLOSED_PARTIAL"
  )
    notFound();
  // El vendedor ya usó su única corrección: el formulario no se le vuelve a
  // ofrecer. La Server Action lo rechaza igual; esto solo evita mostrarle algo
  // que no va a poder guardar.
  if (!canManageAll && pending.sellerEditedAt !== null) notFound();

  const [products, zones] = await Promise.all([
    getProducts({ take: MAX_PAGE_SIZE }),
    getUsedZones(),
  ]);

  const productOptions: ProductOption[] = products.items
    .filter((product) => product.active)
    .map((product) => ({
      id: product.id,
      name: product.name,
      code: product.code,
      orionCode: product.orionCode,
    }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Corregir pendiente"
        description="Se corrigen los datos del pedido. El estado y las entregas no cambian por acá."
      />

      <Card className="space-y-4">
        <PendingEditForm
          pending={pending}
          products={productOptions}
          zones={zones}
          minQuantity={Math.max(pending.deliveredQuantity, pending.invoicedQuantity)}
          isLastChance={!canManageAll}
        />
      </Card>
    </div>
  );
}

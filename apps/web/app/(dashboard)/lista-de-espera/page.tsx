import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import {
  can,
  contactScopeFor,
  invoiceScopeFor,
  seesAllPendings,
} from "@/lib/auth/permissions";
import type { PendingViewer } from "@/features/pendientes/fulfillment-notice";
import { requireCapability } from "@/lib/auth/require-role";
import { PendingCompactList } from "@/features/pendientes/pending-compact-list";
import { getPendings } from "@/server/services/pending.service";

export const metadata: Metadata = { title: "Lista de espera" };

// --------------------------------------------------------------------------
// Lista de espera: los clientes que supieron que su producto demora y
// ACEPTARON esperarlo.
//
// Es una VISTA de los pendientes, no una cola aparte. El pendiente no se mueve
// ni cambia de estado cuando entra acá: sigue en `/pendientes` y además aparece
// en esta pantalla. Por eso no hay nada que sincronizar entre las dos — son las
// mismas filas leídas con un filtro más.
//
// Entran las DOS respuestas. "Va con otro pedido" también es un cliente
// esperando; lo que cambia es que compras no debería comprarlo suelto. La fila
// dice cuál es cuál.
// --------------------------------------------------------------------------
export default async function ListaDeEsperaPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const session = await requireCapability("canViewPendientes");
  const role = session.user.role;

  // Mismo reparto que en `/pendientes`, y por la misma razón: ver la cola
  // entera no es mutarla. El vendedor ve a SUS clientes esperando —que son a
  // los que tiene que llamar—; supervisión y gerencia los ven todos.
  const canSeeAll = seesAllPendings(role);
  const canViewCustomerIdentity = canSeeAll
    ? can(role, "canViewCustomerIdentity")
    : true;

  const canManageAll = can(role, "canManageAllPendings");
  const viewer: PendingViewer = {
    invoiceScope: invoiceScopeFor(role),
    contactScope: contactScopeFor(role),
    userId: session.user.id,
  };

  const { cursor } = await searchParams;

  const pendings = await getPendings({
    cursor,
    // Solo la cola abierta: un pendiente ya entregado o cancelado no tiene a
    // nadie esperando, por más que en su momento alguien haya aceptado esperar.
    scope: "active",
    waitlisted: true,
    canViewCustomerIdentity,
    ownerId: canSeeAll ? undefined : session.user.id,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lista de espera"
        description="Clientes que aceptaron esperar su producto. Siguen siendo pendientes: acá se ven juntos para poder avisarles cuando llegue."
      />

      <PendingCompactList
        items={pendings.items}
        canOrder={can(role, "canOrderMissingItems")}
        canDeliver={can(role, "canDeliverPendings")}
        viewer={viewer}
        canCancel={can(role, "canCancelPendings")}
        canEdit={canManageAll || can(role, "canCreatePendientes")}
        canManageAll={canManageAll}
        // Acá el seguimiento es el trabajo: la pantalla existe para avisarle a
        // una persona concreta, así que quien ve la cola completa necesita
        // cliente, teléfono y zona sobre la misma fila.
        canFollowUp={canManageAll && canViewCustomerIdentity}
        nextCursor={pendings.nextCursor}
        pageHref={(nextCursor) =>
          `/lista-de-espera?cursor=${encodeURIComponent(nextCursor)}`
        }
      />
    </div>
  );
}

import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { PendingList } from "@/features/pendientes/pending-list";
import { PendingReviewFilters } from "@/features/pendientes/pending-review-filters";
import { parseReviewAxes, reviewPageHref } from "@/features/pendientes/review-axes";
import { can } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import type { PendingScope } from "@/server/repositories/pending.repository";
import { getPendings } from "@/server/services/pending.service";

export const metadata: Metadata = { title: "Revisión de pendientes" };

// Cola operativa en vivo: nunca cachear.
export const dynamic = "force-dynamic";

// Los enlaces de filtro y de paginación se arman sobre ESTA ruta. El default de
// `reviewHref` es `/pendientes`: sin pasar esto, el primer clic en un filtro
// sacaba al usuario del módulo y lo dejaba en la cola operativa.
const BASE_PATH = "/revision-pendientes";

// Módulo de revisión de pendientes.
//
// Vive en su propia ruta, separada de `/pendientes`, por la misma razón que
// `/revision-faltantes` vive separada de `/faltantes`: una cosa es la lista con
// la que se trabaja durante el día y otra la superficie donde se revisa cómo
// viene todo. Las dos muestran pendientes; responden preguntas distintas.
//
// El módulo es UNO SOLO para todos los roles. Lo que cambia es el alcance, y no
// lo decide esta pantalla: el vendedor recibe sus propias filas porque abajo va
// `ownerId`, y quien ve la cola entera —por `canManageAllPendings` o por el eje
// de lectura `canReadAllPendings` (T4.4)— no recibe recorte.
// Dos pantallas distintas por rol habrían duplicado la lógica y, tarde o
// temprano, se habrían desincronizado.
//
// El nav ya oculta el link a quien no puede revisar; este guard protege el
// acceso directo a la ruta.
export default async function RevisionPendientesPage({
  searchParams,
}: {
  searchParams: Promise<{
    cursor?: string;
    scope?: string;
    purchase?: string;
    availability?: string;
    customer?: string;
  }>;
}) {
  const session = await requireCapability("canReviewPendings");

  const canManageAll = can(session.user.role, "canManageAllPendings");
  // Eje de LECTURA global (T4.4): ver la cola entera ≠ mutarla. Un rol con
  // `canReadAllPendings` pero sin `canManageAllPendings` vería todo sin poder
  // operar nada ajeno; las acciones siguen gateando SOLO con la segunda.
  const canSeeAll = canManageAll || can(session.user.role, "canReadAllPendings");
  // Quien no ve toda la cola recibe la lista acotada a sus propias filas, así
  // que ve los datos de SUS clientes: son los que tiene que llamar. Ver los de
  // todos es lo que exige la capacidad.
  const canViewCustomerIdentity = canSeeAll
    ? can(session.user.role, "canViewCustomerIdentity")
    : true;
  const canDeliver = can(session.user.role, "canDeliverPendings");
  const canCancel = can(session.user.role, "canCancelPendings");
  const canContactOrInvoice =
    can(session.user.role, "canContactOwnPendings") ||
    can(session.user.role, "canInvoiceOwnPendings");
  // Estado de gestión: autoridad de compras (gerencia). Reusa la misma
  // capability que pedir un faltante, no la de cancelar.
  const canManageStatus = can(session.user.role, "canOrderMissingItems");

  const { cursor, scope: rawScope, ...rawAxes } = await searchParams;

  // Los ejes salen de la URL con la misma desconfianza que el scope: un valor
  // que no está en el enum se descarta y equivale a no filtrar. Estos strings
  // terminan en una consulta contra enums de PostgreSQL.
  const axes = parseReviewAxes(rawAxes);

  // Cualquier valor que no sea exactamente "history" cae en la vista operativa.
  // Un `?scope=cualquier-cosa` no abre los cerrados.
  const scope: PendingScope = rawScope === "history" ? "history" : "active";

  const pendings = await getPendings({
    cursor,
    scope,
    axes,
    canViewCustomerIdentity,
    ownerId: canSeeAll ? undefined : session.user.id,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Revisión de pendientes"
        description={
          canSeeAll
            ? "Cómo viene cada pendiente de la droguería: qué se está consiguiendo, qué llegó y qué falta avisar."
            : "Cómo vienen tus pendientes: qué se está consiguiendo, qué llegó y qué falta avisarle al cliente."
        }
      />

      <PendingReviewFilters
        axes={axes}
        scope={scope}
        view="detalle"
        basePath={BASE_PATH}
      />

      <PendingList
        items={pendings.items}
        nextCursor={pendings.nextCursor}
        canDeliver={canDeliver}
        canCancel={canCancel}
        canManageStatus={canManageStatus}
        canContactOrInvoice={canContactOrInvoice}
        scope={scope}
        pageHref={(nextCursor) =>
          reviewPageHref({ scope, view: "detalle", axes, basePath: BASE_PATH, cursor: nextCursor })
        }
      />
    </div>
  );
}

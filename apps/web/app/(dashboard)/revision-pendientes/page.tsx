import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { PendingList } from "@/features/pendientes/pending-list";
import { PendingReceptionQueue } from "@/features/pendientes/pending-reception-queue";
import { StockoutList } from "@/features/faltantes/stockout-list";
import { ReviewTabs } from "@/features/pendientes/review-tabs";
import { resolveReviewTab } from "@/features/pendientes/review-tab";
import { PendingReviewFilters } from "@/features/pendientes/pending-review-filters";
import { parseReviewAxes, reviewPageHref } from "@/features/pendientes/review-axes";
import { can, seesAllPendings } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import type { PendingScope } from "@/server/repositories/pending.repository";
import {
  countPendingReception,
  listPendingReception,
} from "@/server/services/pending-reception.service";
import { listStockoutProducts } from "@/server/services/stockout.service";
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
    /** Qué mitad de la pantalla: seguimiento o abastecimiento. */
    tab?: string;
  }>;
}) {
  const session = await requireCapability("canReviewPendings");

  const canManageAll = can(session.user.role, "canManageAllPendings");
  // Ver la cola entera ≠ mutarla: la regla vive en `seesAllPendings`, una sola
  // vez. Las acciones de cumplimiento siguen gateando SOLO con `canManageAll`.
  const canSeeAll = seesAllPendings(session.user.role);
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

  const { cursor, scope: rawScope, tab: rawTab, ...rawAxes } = await searchParams;

  // --------------------------------------------------------------------------
  // ABASTECIMIENTO: la mitad FÍSICA del pendiente.
  //
  // Qué llegó, qué falta conseguir, quién lo recibió. Es donde BODEGA trabaja
  // los pedidos de clientes, dentro del mismo módulo que gerencia y no en una
  // pantalla aparte: un pendiente se completa en un solo lugar.
  //
  // NO HAY BOTÓN DE "PEDIDO", y es la regla de negocio, no un recorte: cuando
  // el vendedor registró el pendiente, el cliente YA PIDIÓ el producto. Pedirle
  // a gerencia un segundo clic para "convertirlo en pedido" confundía dos cosas
  // distintas —pedido por el CLIENTE contra pedido al PROVEEDOR— y ataba la
  // recepción a una acción que nadie hacía: bodega no veía nunca el pendiente.
  //
  // La decisión de compra sigue existiendo y sigue siendo de gerencia, pero
  // vive en Seguimiento, con su propio eje (`purchaseStatus`).
  //
  // Quién puede ACTUAR acá es `canReceiveMissingItems`: BODEGA, ADMIN y
  // SUPERADMIN. Bodega es la responsable habitual; gerencia, el respaldo. El
  // vendedor puede MIRAR el estado de sus pendientes —es su cliente el que
  // espera— pero no marca llegadas ni carga entradas.
  // --------------------------------------------------------------------------
  const canReceive = can(session.user.role, "canReceiveMissingItems");
  const tab = resolveReviewTab(rawTab);
  const showingSupply = tab === "abastecimiento";

  const [reception, stockouts, receptionCount] = await Promise.all([
    showingSupply ? listPendingReception() : Promise.resolve(null),
    // Los productos QUE LLEVAMOS y hoy no alcanzan. Va con la cola porque el
    // primer gesto de bodega es el mismo: mirar el depósito antes de esperar.
    showingSupply && canReceive ? listStockoutProducts() : Promise.resolve([]),
    // El contador va SIEMPRE, esté abierta la pestaña o no: un número que solo
    // se calcula al entrar no avisa de nada, que es justo lo que tiene que hacer.
    countPendingReception(),
  ]);

  // Los ejes salen de la URL con la misma desconfianza que el scope: un valor
  // que no está en el enum se descarta y equivale a no filtrar. Estos strings
  // terminan en una consulta contra enums de PostgreSQL.
  const axes = parseReviewAxes(rawAxes);

  // Cualquier valor que no sea exactamente "history" cae en la vista operativa.
  // Un `?scope=cualquier-cosa` no abre los cerrados.
  const scope: PendingScope = rawScope === "history" ? "history" : "active";

  // Solo se consulta la mitad que se está mirando. La otra no se pinta, así
  // que traerla sería pagar una consulta cara —con identidad de cliente— para
  // descartarla.
  const pendings = showingSupply
    ? null
    : await getPendings({
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

      {/* Las pestañas son para todos los que entran: el vendedor también quiere
          saber si lo suyo ya llegó a la droguería. Lo que cambia por rol no es
          la pestaña sino lo que se puede TOCAR adentro. */}
      <ReviewTabs active={tab} supplyCount={receptionCount} />

      {showingSupply ? (
        <>
          <StockoutList items={stockouts} />
          <PendingReceptionQueue items={reception!} canReceive={canReceive} />
        </>
      ) : (
        <>
          <PendingReviewFilters
            axes={axes}
            scope={scope}
            view="detalle"
            basePath={BASE_PATH}
          />

          <PendingList
            items={pendings!.items}
            nextCursor={pendings!.nextCursor}
            canDeliver={canDeliver}
            canCancel={canCancel}
            canManageStatus={canManageStatus}
            canContactOrInvoice={canContactOrInvoice}
            scope={scope}
            pageHref={(nextCursor) =>
              reviewPageHref({ scope, view: "detalle", axes, basePath: BASE_PATH, cursor: nextCursor })
            }
          />
        </>
      )}
    </div>
  );
}

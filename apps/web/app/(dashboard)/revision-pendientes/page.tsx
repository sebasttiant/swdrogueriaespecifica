import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { MissingQueueBoard } from "@/features/faltantes/missing-queue-board";
import { MissingBoardTabs } from "@/features/faltantes/missing-board-tabs";
import {
  PENDING_SUPPLY_ROUTE,
  repositoryScopeFor,
  resolveMissingScope,
} from "@/features/faltantes/missing-scope";
import { resolveMissingView } from "@/features/faltantes/missing-view";
import { PendingList } from "@/features/pendientes/pending-list";
import { ReviewTabs } from "@/features/pendientes/review-tabs";
import { resolveReviewTab } from "@/features/pendientes/review-tab";
import { PendingReviewFilters } from "@/features/pendientes/pending-review-filters";
import { parseReviewAxes, reviewPageHref } from "@/features/pendientes/review-axes";
import { can, seesAllPendings } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import type { PendingScope } from "@/server/repositories/pending.repository";
import {
  getActionableMissingCount,
  getMissingItems,
} from "@/server/services/missing-item.service";
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
    // Ejes del tablero de abastecimiento. Llevan prefijo `s` porque `scope`,
    // `view` y `cursor` ya son de la lista de pendientes de arriba: sin el
    // prefijo, mover un tablero movería el otro. Ver `missing-scope.ts`.
    sscope?: string;
    sview?: string;
    scursor?: string;
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

  const {
    cursor,
    scope: rawScope,
    tab: rawTab,
    sscope: rawSupplyScope,
    sview: rawSupplyView,
    scursor: rawSupplyCursor,
    ...rawAxes
  } = await searchParams;

  // --------------------------------------------------------------------------
  // ABASTECIMIENTO: qué hay que COMPRAR para cumplir los pedidos de cliente.
  //
  // Es la misma mesa de trabajo de Revisión de faltantes —mismas pestañas,
  // mismas palabras, mismo gesto de un toque— pero acotada por ORIGEN: solo lo
  // que nació de un pendiente. La reposición de estantería sigue viviendo en
  // Revisión de faltantes. El origen decide la pantalla; el gerente no tiene
  // que acordarse de filtrar.
  //
  // La autoridad de compras es la MISMA que en la otra pantalla
  // (`canOrderMissingItems`), no una nueva: quien puede pedir, puede pedir, sin
  // importar desde dónde lo toca. Un vendedor entra a esta pantalla por
  // `canReviewPendings` y ve su seguimiento; la mitad de abastecimiento no
  // existe para él.
  // --------------------------------------------------------------------------
  const tab = canManageStatus ? resolveReviewTab(rawTab) : "seguimiento";
  const showingSupply = tab === "abastecimiento";

  const supplyScope = resolveMissingScope(rawSupplyScope);
  const supplyView = resolveMissingView(rawSupplyView);

  const [supplyQueue, supplyCount] = await Promise.all([
    showingSupply
      ? getMissingItems({
          cursor: rawSupplyCursor,
          scope: repositoryScopeFor(supplyScope),
          // El corazón de esta pantalla: SOLO lo que nació de un pedido de
          // cliente. Sin este eje volvería a mezclarse la estantería, que es
          // justo lo que se pidió separar.
          origin: "pending",
          canViewCustomerIdentity,
          canViewSupplierIdentity: can(session.user.role, "canViewSupplierIdentity"),
        })
      : Promise.resolve(null),
    // El contador va SIEMPRE, esté abierta la pestaña o no: un número que solo
    // se calcula al entrar no avisa de nada, que es justo lo que tiene que hacer.
    canManageStatus ? getActionableMissingCount("pending") : Promise.resolve(0),
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

      {/* Las pestañas solo existen para quien puede comprar. Al vendedor no se
          le muestra una mitad que no puede usar: sería un lugar más donde tocar
          sin que pase nada. */}
      {canManageStatus ? (
        <ReviewTabs active={tab} supplyCount={supplyCount} />
      ) : null}

      {showingSupply ? (
        <>
          {/* Las MISMAS pestañas y las MISMAS palabras que Revisión de
              faltantes. Quien las usa tiene 60 años: que se parezcan es lo que
              evita tener que aprender dos cosas. Sin buzón de reportes, porque
              un pedido de cliente no nace de un reporte de vendedor. */}
          <MissingBoardTabs
            active={supplyScope}
            view={supplyView}
            actionableCount={supplyCount}
            reportsCount={null}
            route={PENDING_SUPPLY_ROUTE}
            label="Estado del abastecimiento"
          />

          <MissingQueueBoard
            items={supplyQueue!.items}
            nextCursor={supplyQueue!.nextCursor}
            scope={supplyScope}
            view={supplyView}
            canAct={canManageStatus}
            // El export de la cola es de estantería y baja TODO lo abierto sin
            // distinguir origen. Ofrecerlo acá prometería un archivo de esta
            // pantalla y entregaría otro. Queda para su propio PR.
            canExport={false}
            canSeeSupplier={can(session.user.role, "canViewSupplierIdentity")}
            now={new Date()}
            route={PENDING_SUPPLY_ROUTE}
            label="Vista del abastecimiento"
          />
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

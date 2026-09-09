import Link from "next/link";
import { PackageCheck } from "lucide-react";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { MissingItemStatus } from "@/lib/generated/prisma/client";
import { cn } from "@/lib/utils/cn";
import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";
import type { MissingItemListEntry } from "@/server/services/missing-item.service";
import {
  computeDeadlineStatus,
  type DeadlineStatus,
} from "../pendientes/deadline-status";
import { groupMissingItems, type MissingGroupKey } from "./missing-grouping";
import { MISSING_BULK_FORM_ID } from "./missing-bulk-selection";
import { getOrderMetadata, orderedQuantityLabel } from "./missing-list-helpers";
import type { MissingQueueScope } from "./missing-scope";
import { canDiscard } from "./order-rules";
import { MissingQuickActions } from "./missing-quick-actions";

type MissingListProps = {
  items: MissingItemListEntry[];
  nextCursor: string | null;
  // Construye la URL de la página siguiente preservando el scope. Sin esto,
  // "Ver más" devolvía siempre a la cola por defecto.
  pageHref: (cursor: string) => string;
  // Autoridad de compras para las acciones de un toque (✓ pedido / ✗ descartar).
  canQuickAct: boolean;
  // Autoridad de compras (`canOrderMissingItems`): habilita ver los badges de
  // estado y vencimiento. El vendedor reporta y sigue operando; para él la cola
  // es solo producto/cantidad/solicitante, sin el seguimiento de gerencia. Es
  // un eje distinto de `canQuickAct`: ver en qué anda un faltante no es poder
  // tocarlo. El SCOPE decide además si la columna aplica: ver `scope` abajo.
  canSeeStatus: boolean;
  // Gatea la columna "Pedido" (proveedor · fecha · cantidad pedida). Un vendedor
  // NO debe saber a qué depósito le compra la droguería. Eje distinto de
  // `canSeeStatus`: saber en qué anda el faltante no es saber a quién se le
  // pide. El SCOPE decide además si la columna aplica: ver `scope` abajo.
  canSeeSupplier: boolean;
  // Capability `canViewMissingAttribution` (SUPERADMIN/ADMIN): gatea la
  // columna Fecha. "Solicitado por" (el nombre) queda visible para TODOS —esta
  // capability no la toca—; solo la fecha exacta es trazabilidad de gerencia.
  canSeeRequestedAt: boolean;
  // Alcance operativo de la página (`missing-scope.ts`). Estado y Pedido solo
  // aportan en "ordered"/"discarded", donde SÍ distinguen una fila de otra
  // (PEDIDO vs RECIBIDO, y a qué proveedor). En "actionable" ("Por pedir") todo
  // es FALTANTE: la columna sería constante, puro ruido. Los dos ejes se
  // combinan: la columna se muestra si el scope la justifica Y el permiso
  // (`canSeeStatus`/`canSeeSupplier`) la habilita.
  scope: MissingQueueScope;
  // Instante compartido con `MissingSummary` para que ambas piezas hablen del
  // mismo momento (deadline badges + agrupación de urgencia).
  now: Date;
  // Selección masiva (modo alternativo, activado por `?bulk=1` y resuelto en
  // `missing-queue-board.tsx` como `canAct && bulkMode`). En este modo la fila
  // NO monta `MissingQuickActions`: tener la acción individual y la masiva a
  // la vez es el mismo defecto de duplicación un nivel más abajo. Por defecto
  // apagado, para no tocar el árbol de nadie que no pida el modo.
  bulkMode?: boolean;
};

// Etiqueta y tono del encabezado de cada grupo de urgencia.
const GROUP_LABEL: Record<
  MissingGroupKey,
  { text: string; tone: "danger" | "warning" | "neutral" }
> = {
  VENCIDO: { text: "Vencidos", tone: "danger" },
  VENCE_PRONTO: { text: "Vencen pronto", tone: "warning" },
  EN_CURSO: { text: "En curso", tone: "neutral" },
};

const STATUS: Record<
  MissingItemStatus,
  { label: string; tone: "neutral" | "success" | "warning" | "danger" }
> = {
  FALTANTE: { label: "Faltante", tone: "danger" },
  PEDIDO: { label: "Pedido", tone: "warning" },
  EN_BODEGA: { label: "En bodega", tone: "warning" },
  RECIBIDO: { label: "Recibido", tone: "success" },
  CANCELADO: { label: "Cancelado", tone: "neutral" },
};

const DEADLINE: Record<
  DeadlineStatus,
  { label: string; tone: "neutral" | "success" | "warning" | "danger" }
> = {
  VENCIDO: { label: "Vencido", tone: "danger" },
  VENCE_PRONTO: { label: "Vence pronto", tone: "warning" },
  A_TIEMPO: { label: "A tiempo", tone: "success" },
  FINALIZADO: { label: "Finalizado", tone: "neutral" },
};

// Etiqueta de vencimiento del pendiente que originó el faltante (null = manual).
function deadlineBadge(origin: MissingItemListItem["origin"], now: Date) {
  if (!origin) return null;
  const deadline = DEADLINE[computeDeadlineStatus(origin.promisedAt, origin.status, now)];
  return <Badge tone={deadline.tone}>{deadline.label}</Badge>;
}

// `confirmedAt` NO es redundante con el status. Los registros del camino viejo
// ("OK gerencia") quedaron en FALTANTE con `confirmedAt` seteado: gerencia ya
// había pedido, pero sin registrar proveedor. No se les vuelve a ofrecer marcar
// de nuevo. Simplificar esta condición reintroduce el bug.
function canOrderItem(missing: MissingItemListItem): boolean {
  return missing.status === "FALTANTE" && missing.confirmedAt === null;
}

// Contexto de render de una fila: quién puede pedir (acción) y quién ve el
// seguimiento (badges de estado/vencimiento). Agrupado para no arrastrar
// parámetros posicionales por cada helper de render.
//
// `canSeeStatus`/`canSeeSupplier` acá YA son el resultado combinado de permiso
// + scope (ver `MissingList` más abajo): las filas no vuelven a mirar el
// scope, solo leen si la columna aplica.
type ActionContext = {
  // Pedido rápido y descarte: la única autoridad que la fila necesita.
  canQuickAct: boolean;
  canSeeStatus: boolean;
  // Identidad del proveedor. El service YA la anuló para quien no la tiene, así
  // que esto solo evita pintar una columna vacía; la protección real no vive acá.
  canSeeSupplier: boolean;
  // Columna Fecha: capability pura (`canViewMissingAttribution`), sin eje de
  // scope — a diferencia de status/supplier, aplica igual en las tres colas.
  canSeeRequestedAt: boolean;
  // Selección masiva: ver `MissingListProps.bulkMode`. Se exige también
  // `canQuickAct` acá abajo, en la propia fila, en vez de confiar en que quien
  // arma la página ya lo hizo — la misma defensa en profundidad que ya usa el
  // resto del contexto.
  bulkMode: boolean;
};

// --------------------------------------------------------------------------
// La fila ofrece EXACTAMENTE DOS salidas y nada más.
//
// Antes convivían acá el pedido de un toque y el formulario largo con proveedor
// y cantidad. Eran dos botones pegados llamados "Pedido" y "Pedir": nombres casi
// idénticos, efectos distintos. Quien usa esta pantalla es un gerente de 60 años
// desde el celular, marcando decenas de filas seguidas; esa pareja de botones
// era un error esperando pasar.
//
// El formulario largo se retira de la cola de trabajo. Registrar a qué proveedor
// y en qué cantidad se compró nunca fue algo que gerencia pidiera —trabaja por
// laboratorio y pide por teléfono—, así que dejó de ocupar el camino principal.
// La capacidad sigue existiendo en el servidor, con sus tests: si más adelante
// hace falta, se ofrece desde "Ya pedidos" para completar el detalle DESPUÉS de
// marcar, nunca antes.
// --------------------------------------------------------------------------
function missingActions(
  missing: MissingItemListItem,
  actions: ActionContext,
  className?: string,
) {
  if (!actions.canQuickAct || !canOrderItem(missing)) return null;

  return (
    <div className={cn("flex flex-col items-end gap-2", className)}>
      <MissingQuickActions
        missingItemId={missing.id}
        productName={missing.product.name}
      />
    </div>
  );
}

// Casilla de selección masiva. Mismo criterio de elegibilidad que ya filtra
// `missing-queue-board.tsx` para armar la barra: `canDiscard(item.status)`.
// Deliberadamente NO mira `confirmedAt` — ver la nota de `canOrderItem` sobre
// la asimetría preexistente que este trabajo no corrige. Vive FUERA del
// `<form>` de la barra: se asocia por el atributo `form`, no por anidamiento.
function missingBulkCheckbox(missing: MissingItemListItem) {
  if (!canDiscard(missing.status)) return null;

  return (
    <input
      type="checkbox"
      name="ids"
      value={missing.id}
      form={MISSING_BULK_FORM_ID}
      aria-label={`Seleccionar ${missing.product.name}`}
      className="h-4 w-4 shrink-0 rounded border-border accent-primary"
    />
  );
}

// En modo masivo la fila despacha en LOTE, nunca junto con la acción
// individual: tenerlas a la vez es el mismo defecto de duplicación un nivel
// más abajo. Cuando el modo está apagado, esto es exactamente
// `missingActions(missing, actions)` — el árbol no cambia un bit.
function missingActionsOrCheckbox(missing: MissingItemListItem, actions: ActionContext) {
  return actions.canQuickAct && actions.bulkMode
    ? missingBulkCheckbox(missing)
    : missingActions(missing, actions);
}

// Proveedor y fecha de una orden en curso. `getOrderMetadata` ya decide si el
// faltante tiene un pedido que mostrar; acá solo se formatea.
function orderDetails(missing: MissingItemListItem) {
  const order = getOrderMetadata(missing);
  if (!order) return null;

  return (
    <>
      <p>Proveedor: {order.supplierName ?? "Proveedor sin registrar"}</p>
      {order.orderedAt ? (
        <p>Pedido: {formatBogotaDate(order.orderedAt, { style: "datetime" })}</p>
      ) : null}
      <p>{orderedQuantityLabel(order.orderedQuantity, order.receivedQuantity)}</p>
    </>
  );
}

// Misma información en la celda desktop. El guion marca las filas sin pedido
// para que la columna no quede visualmente vacía.
function orderCell(missing: MissingItemListItem) {
  const order = getOrderMetadata(missing);
  if (!order) return <span className="text-muted-foreground">—</span>;

  return (
    <div className="space-y-0.5">
      <p className="font-medium text-text">
        {order.supplierName ?? "Proveedor sin registrar"}
      </p>
      {order.orderedAt ? (
        <p className="text-muted-foreground">
          {formatBogotaDate(order.orderedAt, { style: "datetime" })}
        </p>
      ) : null}
      <p className="text-muted-foreground">
        {orderedQuantityLabel(order.orderedQuantity, order.receivedQuantity)}
      </p>
    </div>
  );
}

// Tarjeta mobile de un faltante. Extraída para reusarse dentro de cada
// sección de grupo sin duplicar el markup.
function missingCard(
  missing: MissingItemListEntry,
  now: Date,
  actions: ActionContext,
) {
  const status = STATUS[missing.status];
  const origin = missing.origin;

  // Jerarquía operativa: producto y cantidad arriba, estado como chip, acción
  // siempre visible. Todo lo demás (origen, promesa, pedido) es
  // contexto secundario y va colapsado: en la cola no se lee, se actúa.
  return (
    <Card key={missing.id} className="space-y-3 p-4">
      <div className="min-w-0">
        <p className="break-words text-base font-semibold text-text">
          {missing.product.name}
          {missing.originId ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">auto</span>
          ) : null}
        </p>
        {/* Trazabilidad (Mejora 5): quién lo pidió. El vendedor que reportó,
            o quien lo creó. Visible para todos: es contexto operativo. */}
        {missing.requestedByName ? (
          <p className="break-words text-xs text-muted-foreground">
            Solicitado por {missing.requestedByName}
          </p>
        ) : null}
        {/* Columna Fecha: capability `canViewMissingAttribution`
            (SUPERADMIN/ADMIN). Misma fecha que dio nombre a "Solicitado
            por" arriba —el service las ata al mismo evento—, así que nunca
            se muestra una sin la otra. */}
        {actions.canSeeRequestedAt ? (
          <p className="text-xs text-muted-foreground">
            {formatBogotaDate(missing.requestedAt, { style: "date" })}
          </p>
        ) : null}
      </div>

      {/* Seguimiento (vencimiento + estado): solo gerencia, y solo en las
          colas donde distingue algo ("ordered"/"discarded" — ver `scope` en
          `MissingList`). El vendedor ve la fila sin badges: reporta y sigue
          operando. */}
      {actions.canSeeStatus ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {deadlineBadge(origin, now)}
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      ) : null}

      {missingActionsOrCheckbox(missing, actions)}

      <details className="group">
        <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground hover:text-text">
          Ver detalle
        </summary>
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          {missing.note ? <p>Nota: {missing.note}</p> : null}
          {actions.canSeeSupplier ? orderDetails(missing) : null}
          {origin ? (
            <>
              <p>
                Origen: pendiente
                {origin.customerName ? ` · ${origin.customerName}` : ""}
              </p>
              <p>
                Promesa: {formatBogotaDate(origin.promisedAt, { style: "datetime" })}
              </p>
            </>
          ) : null}
        </div>
      </details>
    </Card>
  );
}

// Fila desktop de un faltante. Misma razón de ser que `missingCard`.
function missingRow(
  missing: MissingItemListEntry,
  now: Date,
  actions: ActionContext,
) {
  const status = STATUS[missing.status];
  const hasActions = actions.canQuickAct;
  return (
    <tr key={missing.id} className="border-b border-border last:border-0">
      <td className="px-3 py-2 font-medium text-text">
        {missing.product.name}
        {missing.originId ? (
          <span className="ml-2 text-xs font-normal text-muted-foreground">auto</span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-sm text-muted-foreground">
        {missing.requestedByName ?? "—"}
      </td>
      {actions.canSeeRequestedAt ? (
        <td className="px-3 py-2 text-sm text-muted-foreground">
          {formatBogotaDate(missing.requestedAt, { style: "date" })}
        </td>
      ) : null}
      {actions.canSeeStatus ? (
        <td className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            {deadlineBadge(missing.origin, now)}
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
        </td>
      ) : null}
      {actions.canSeeSupplier ? (
        <td className="px-3 py-2 text-sm">{orderCell(missing)}</td>
      ) : null}
      {hasActions ? (
        <td className="px-3 py-2">{missingActionsOrCheckbox(missing, actions)}</td>
      ) : null}
    </tr>
  );
}

// Listado presentacional (server component). Mobile-first: tarjetas apiladas.
// Desktop (lg+): tabla simple tipo checklist con scroll horizontal. Los items
// de la página actual se agrupan por urgencia operativa (ver
// `missing-grouping.ts`); el resumen global vive en `MissingSummary`.
export function MissingList({
  items,
  nextCursor,
  pageHref,
  canQuickAct,
  canSeeStatus,
  canSeeSupplier,
  canSeeRequestedAt,
  scope,
  bulkMode = false,
  now,
}: MissingListProps) {
  // Estado y Pedido solo distinguen algo en "ordered"/"discarded": en
  // "actionable" ("Por pedir") TODO es FALTANTE y la columna sería constante.
  // El permiso (`canSeeStatus`/`canSeeSupplier`) sigue gobernando el eje de
  // autoridad; acá se combina con lo que el scope justifica.
  const showsStatus = canSeeStatus && scope !== "actionable";
  const showsSupplier = canSeeSupplier && scope !== "actionable";

  const actions: ActionContext = {
    canQuickAct,
    canSeeStatus: showsStatus,
    canSeeSupplier: showsSupplier,
    canSeeRequestedAt,
    bulkMode,
  };

  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={PackageCheck}
          title="Sin faltantes críticos"
          description="No hay faltantes pendientes por ahora. Todo al día."
        />
      </Card>
    );
  }

  const groups = groupMissingItems(items, now);

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const label = GROUP_LABEL[group.key];
        const headingId = `faltantes-grupo-${group.key.toLowerCase()}`;

        return (
          <section key={group.key} className="space-y-3" aria-labelledby={headingId}>
            <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-text">
              {label.text}
              <Badge tone={label.tone}>{group.items.length}</Badge>
            </h2>

            {/* Mobile / tablet: tarjetas apiladas y tocables. */}
            <div className="space-y-3 lg:hidden">
              {group.items.map((missing) =>
                missingCard(missing, now, actions),
              )}
            </div>

            {/* Desktop: tabla simple tipo checklist. Scroll horizontal si no entra. */}
            <Card className="hidden overflow-x-auto p-0 lg:block">
              <table className="w-full min-w-[56rem] text-left text-sm">
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Producto</th>
                    <th className="px-3 py-2 font-medium">Solicitado por</th>
                    {canSeeRequestedAt ? (
                      <th className="px-3 py-2 font-medium">Fecha</th>
                    ) : null}
                    {showsStatus ? (
                      <th className="px-3 py-2 font-medium">Estado</th>
                    ) : null}
                    {showsSupplier ? (
                      <th className="px-3 py-2 font-medium">Pedido</th>
                    ) : null}
                    {canQuickAct ? (
                      <th className="px-3 py-2 text-right font-medium">Acción</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((missing) =>
                    missingRow(missing, now, actions),
                  )}
                </tbody>
              </table>
            </Card>
          </section>
        );
      })}

      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link prefetch={false}
            href={pageHref(nextCursor)}
            className="inline-flex min-h-11 items-center px-4 text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}

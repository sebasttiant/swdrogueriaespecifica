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
import { getOrderMetadata, orderedQuantityLabel } from "./missing-list-helpers";
import { MissingQuickActions } from "./missing-quick-actions";

type MissingListProps = {
  items: MissingItemListEntry[];
  nextCursor: string | null;
  // Construye la URL de la página siguiente preservando vista y layout. Sin
  // esto, "Ver más" devolvía siempre a la cola por defecto.
  pageHref: (cursor: string) => string;
  // Autoridad de compras para las acciones de un toque (✓ pedido / ✗ descartar).
  canQuickAct: boolean;
  // Autoridad de compras (`canOrderMissingItems`): habilita ver los badges de
  // estado y vencimiento. El vendedor reporta y sigue operando; para él la cola
  // es solo producto/cantidad/código, sin el seguimiento de gerencia. Es un eje
  // distinto de `canQuickAct`: ver en qué anda un faltante no es poder tocarlo.
  canSeeStatus: boolean;
  // Gatea la columna "Pedido" (proveedor · fecha · cantidad pedida). Un vendedor
  // NO debe saber a qué depósito le compra la droguería. Eje distinto de
  // `canSeeStatus`: saber en qué anda el faltante no es saber a quién se le pide.
  canSeeSupplier: boolean;
  // Instante compartido con `MissingSummary` para que ambas piezas hablen del
  // mismo momento (deadline badges + agrupación de urgencia).
  now: Date;
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
type ActionContext = {
  // Pedido rápido y descarte: la única autoridad que la fila necesita.
  canQuickAct: boolean;
  canSeeStatus: boolean;
  // Identidad del proveedor. El service YA la anuló para quien no la tiene, así
  // que esto solo evita pintar una columna vacía; la protección real no vive acá.
  canSeeSupplier: boolean;
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
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-text">
            {missing.product.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {missing.product.code}
            {missing.originId ? " · auto" : ""}
          </p>
          {/* Trazabilidad (Mejora 5): quién lo pidió. El vendedor que reportó,
              o quien lo creó. Visible para todos: es contexto operativo. */}
          {missing.requestedByName ? (
            <p className="truncate text-xs text-muted-foreground">
              Solicitado por {missing.requestedByName}
            </p>
          ) : null}
        </div>
        <p className="shrink-0 text-lg font-bold tabular-nums text-text">
          {missing.originId ? (
            <>
              {missing.quantity}
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {missing.product.unit}
              </span>
            </>
          ) : missing.sellerCode ? (
            <>
              <span className="font-mono">{missing.sellerCode}</span>
              <span className="ml-1 text-xs font-normal text-muted-foreground">vendedor</span>
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </p>
      </div>

      {/* Seguimiento (vencimiento + estado): solo gerencia. El vendedor ve la
          fila sin badges: reporta y sigue operando. */}
      {actions.canSeeStatus ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {deadlineBadge(origin, now)}
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      ) : null}

      {missingActions(missing, actions)}

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
      <td className="px-3 py-2 text-muted-foreground">{missing.product.code}</td>
      <td className="px-3 py-2 text-muted-foreground">
        {missing.originId ? (
          <>
            {missing.quantity} {missing.product.unit}
          </>
        ) : missing.sellerCode ? (
          <span className="font-mono">{missing.sellerCode}</span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2 text-sm text-muted-foreground">
        {missing.note ? `Nota: ${missing.note}` : "—"}
      </td>
      <td className="px-3 py-2 text-sm text-muted-foreground">
        {missing.requestedByName ?? "—"}
      </td>
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
        <td className="px-3 py-2">{missingActions(missing, actions)}</td>
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
  now,
}: MissingListProps) {
  const actions: ActionContext = {
    canQuickAct,
    canSeeStatus,
    canSeeSupplier,
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
                    <th className="px-3 py-2 font-medium">Código</th>
                    <th className="px-3 py-2 font-medium">Referencia</th>
                    <th className="px-3 py-2 font-medium">Nota</th>
                    <th className="px-3 py-2 font-medium">Solicitado por</th>
                    {canSeeStatus ? (
                      <th className="px-3 py-2 font-medium">Estado</th>
                    ) : null}
                    {canSeeSupplier ? (
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
          <Link
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

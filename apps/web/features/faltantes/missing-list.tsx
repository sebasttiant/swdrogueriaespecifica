import Link from "next/link";
import { PackageCheck } from "lucide-react";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { MissingItemStatus } from "@/lib/generated/prisma/client";
import { cn } from "@/lib/utils/cn";
import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";
import type { SupplierOption } from "@/server/repositories/supplier.repository";
import {
  computeDeadlineStatus,
  type DeadlineStatus,
} from "../pendientes/deadline-status";
import { groupMissingItems, type MissingGroupKey } from "./missing-grouping";
import { MissingConfirmForm } from "./missing-confirm-form";
import {
  getConfirmationMetadata,
  getOrderMetadata,
  getPageOverview,
} from "./missing-list-helpers";
import { MissingOrderForm } from "./missing-order-form";

type MissingListProps = {
  items: MissingItemListItem[];
  nextCursor: string | null;
  canConfirm: boolean;
  canOrder: boolean;
  // Proveedores elegibles para el pedido. Vacío = todavía no hay ninguno, así
  // que la única rama posible es crear uno nuevo.
  suppliers: SupplierOption[];
  canCreateSupplier: boolean;
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

function overviewTile(label: string, value: number, description: string) {
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-4">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

// Etiqueta de vencimiento del pendiente que originó el faltante (null = manual).
function deadlineBadge(origin: MissingItemListItem["origin"], now: Date) {
  if (!origin) return null;
  const deadline = DEADLINE[computeDeadlineStatus(origin.promisedAt, origin.status, now)];
  return <Badge tone={deadline.tone}>{deadline.label}</Badge>;
}

// La confirmación ("OK gerencia") solo aplica a un faltante que sigue
// FALTANTE y sin confirmar. Un PEDIDO ya no se confirma (invariante del
// service: nunca PEDIDO + confirmedAt), y los estados cerrados tampoco. El
// botón no se ofrece sobre estados muertos, así que no quedan caminos
// obsoletos que disparen un submit sin destino válido.
function canConfirmItem(missing: MissingItemListItem): boolean {
  return missing.status === "FALTANTE" && missing.confirmedAt === null;
}

function canOrderItem(missing: MissingItemListItem): boolean {
  return missing.status === "FALTANTE" && missing.confirmedAt === null;
}

// Contexto de las acciones de una fila. Agrupado para no arrastrar cuatro
// booleanos posicionales por cada helper de render.
type ActionContext = {
  canConfirm: boolean;
  canOrder: boolean;
  suppliers: SupplierOption[];
  canCreateSupplier: boolean;
};

function missingActions(
  missing: MissingItemListItem,
  actions: ActionContext,
  className?: string,
) {
  const showConfirm = actions.canConfirm && canConfirmItem(missing);
  const showOrder = actions.canOrder && canOrderItem(missing);

  if (!showConfirm && !showOrder) return null;

  return (
    <div className={cn("flex flex-col items-end gap-2", className)}>
      {showConfirm ? <MissingConfirmForm id={missing.id} /> : null}
      {showOrder ? (
        <MissingOrderForm
          id={missing.id}
          suppliers={actions.suppliers}
          canCreateSupplier={actions.canCreateSupplier}
        />
      ) : null}
    </div>
  );
}

function confirmationMetadata(missing: MissingItemListItem) {
  const metadata = getConfirmationMetadata(missing);

  if (!metadata.confirmedAt) {
    return <span className="text-muted-foreground">{metadata.label}</span>;
  }

  return (
    <span className="text-success">
      {metadata.label}: {formatBogotaDate(metadata.confirmedAt, { style: "datetime" })}
    </span>
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
    </div>
  );
}

// Tarjeta mobile de un faltante. Extraída para reusarse dentro de cada
// sección de grupo sin duplicar el markup.
function missingCard(
  missing: MissingItemListItem,
  now: Date,
  actions: ActionContext,
) {
  const status = STATUS[missing.status];
  const origin = missing.origin;
  return (
    <Card key={missing.id} className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-text sm:text-lg">
            {missing.product.name}
          </p>
          <p className="text-sm font-medium text-muted-foreground">
            Código {missing.product.code}
            {missing.originId ? " · auto" : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {deadlineBadge(origin, now)}
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            Cantidad: {missing.quantity} {missing.product.unit}
          </p>
          <p>Confirmación: {confirmationMetadata(missing)}</p>
          {orderDetails(missing)}
          {origin ? (
            <>
              <p>Origen: pendiente{origin.customerName ? ` · ${origin.customerName}` : ""}</p>
              <p>Promesa: {formatBogotaDate(origin.promisedAt, { style: "datetime" })}</p>
            </>
          ) : null}
        </div>

        {missingActions(missing, actions, "sm:self-end")}
      </div>
    </Card>
  );
}

// Fila desktop de un faltante. Misma razón de ser que `missingCard`.
function missingRow(
  missing: MissingItemListItem,
  now: Date,
  actions: ActionContext,
) {
  const status = STATUS[missing.status];
  const hasActions = actions.canConfirm || actions.canOrder;
  return (
    <tr key={missing.id} className="border-b border-border last:border-0">
      <td className="px-4 py-3 font-medium text-text">
        {missing.product.name}
        {missing.originId ? (
          <span className="ml-2 text-xs font-normal text-muted-foreground">auto</span>
        ) : null}
      </td>
      <td className="px-4 py-3 text-muted-foreground">{missing.product.code}</td>
      <td className="px-4 py-3 text-muted-foreground">
        {missing.quantity} {missing.product.unit}
      </td>
      <td className="px-4 py-3 text-sm">{confirmationMetadata(missing)}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          {deadlineBadge(missing.origin, now)}
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      </td>
      <td className="px-4 py-3 text-sm">{orderCell(missing)}</td>
      {hasActions ? (
        <td className="px-4 py-3">{missingActions(missing, actions)}</td>
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
  canConfirm,
  canOrder,
  suppliers,
  canCreateSupplier,
  now,
}: MissingListProps) {
  const actions: ActionContext = {
    canConfirm,
    canOrder,
    suppliers,
    canCreateSupplier,
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
  const overview = getPageOverview(items);

  return (
    <div className="space-y-6">
      <section className="space-y-3" aria-labelledby="faltantes-page-overview-title">
        <div className="space-y-1">
          <p className="text-sm font-semibold uppercase tracking-wide text-primary">
            Vista de la página
          </p>
          <h2 id="faltantes-page-overview-title" className="text-lg font-bold text-text">
            Seguimiento operativo
          </h2>
          <p className="text-sm text-muted-foreground">
            Estos indicadores usan solo los faltantes cargados en esta página. El
            resumen superior refleja el total global.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {overviewTile("En esta página", overview.total, "Registros cargados ahora")}
          {overviewTile("Abiertos", overview.open, "Faltante o pedido sin confirmar")}
          {overviewTile("Confirmados", overview.confirmed, "Con OK gerencia")}
        </div>
      </section>

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
                    <th className="px-4 py-3 font-medium">Producto</th>
                    <th className="px-4 py-3 font-medium">Código</th>
                    <th className="px-4 py-3 font-medium">Cantidad</th>
                    <th className="px-4 py-3 font-medium">Confirmación</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 font-medium">Pedido</th>
                    {canConfirm || canOrder ? (
                      <th className="px-4 py-3 text-right font-medium">Acción</th>
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
            href={`/faltantes?cursor=${encodeURIComponent(nextCursor)}`}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}

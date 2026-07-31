import Link from "next/link";
import { ClipboardCheck } from "lucide-react";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import { cn } from "@/lib/utils/cn";
import type { PendingListItem } from "@/server/repositories/pending.repository";

import { computeDeadlineStatus } from "./deadline-status";
import {
  isManagementStatus,
  MANAGEMENT_STATUS_LABELS,
} from "./management-status";
import { canSetManagementStatus } from "./management-status";
import { PendingManagementStatusForm } from "./pending-management-status-form";
import { PendingCustomerLifecycleForm } from "./pending-customer-lifecycle-form";
import { PendingDeliverForm } from "./pending-deliver-form";

// --------------------------------------------------------------------------
// Vista LISTADO de pendientes — la que pidió el gerente en la reunión del
// 2026-07-30: "me falta que lo muestre en listado... un listadito, para que
// Andrés y don Guillermo sepan quién ha pedido qué, y que le puedan colocar el
// okay".
//
// Es la vista de COMPRAS, no la del vendedor. Por eso muestra menos, no más:
//
//   producto · cantidad · quién lo pidió · para cuándo · estado · acción
//
// Queda deliberadamente afuera todo lo que es del mostrador —cliente, teléfono,
// dirección, zona, abonos, entregado parcial—. Quien compra no necesita saber a
// qué cliente va: necesita ver rápido qué conseguir y marcarlo. La vista
// detallada conserva todo eso intacto para quien sí lo usa.
//
// El renglón por fila cabe de un vistazo. Con 36 pendientes a las 9:30 de la
// mañana, ese es el punto entero.
// --------------------------------------------------------------------------

type PendingCompactListProps = {
  items: PendingListItem[];
  // Autoridad de compras: habilita el "Ya lo pedí". La Server Action revalida
  // igual, así que esto solo evita ofrecer un control que sería rechazado.
  canOrder: boolean;
  // La vista compacta no puede cortar la cola en la primera página: el cursor
  // viene del mismo query paginado que alimenta la vista detallada.
  nextCursor: string | null;
  // La página construye la URL para conservar scope y formato al avanzar.
  pageHref: (cursor: string) => string;
  canDeliver?: boolean;
  canContactOrInvoice?: boolean;
};

// Urgencia como texto + color, nunca solo color: la mitad de las decisiones se
// toman de un vistazo y en un celular al sol.
const URGENCY: Record<
  ReturnType<typeof computeDeadlineStatus>,
  { label: string; tone: "danger" | "warning" | "success" | "neutral" }
> = {
  VENCIDO: { label: "Vencido", tone: "danger" },
  VENCE_PRONTO: { label: "Vence pronto", tone: "warning" },
  A_TIEMPO: { label: "A tiempo", tone: "success" },
  FINALIZADO: { label: "Finalizado", tone: "neutral" },
};

// Los estados de gestión viven en el MISMO enum que el ciclo de vida, así que
// "todavía sin gestionar" es `PENDIENTE`. Se dice "Por pedir" y no "Pendiente"
// porque en esta vista lo que importa es qué hacer, no cómo se llama el estado.
function isTerminal(item: PendingListItem): boolean {
  return (
    item.status === "ENTREGADO" ||
    item.status === "CANCELADO" ||
    item.customerStatus === "ENTREGADO" ||
    item.customerStatus === "CANCELADO"
  );
}

function managementLabel(item: PendingListItem): string {
  if (item.customerStatus === "ENTREGADO" || item.status === "ENTREGADO") return "Entregado";
  if (item.customerStatus === "CANCELADO" || item.status === "CANCELADO") return "Cancelado";
  if (item.status === "PARCIAL") return "Entrega parcial";
  const purchaseStatus = item.purchaseStatus ?? "POR_PEDIR";
  return isManagementStatus(purchaseStatus)
    ? MANAGEMENT_STATUS_LABELS[purchaseStatus]
    : "Por pedir";
}

// Cuánto de este pendiente ya está en bodega y todavía no se facturó, y cuánto
// se facturó y todavía no se entregó. Son las dos cifras que definen qué puede
// hacer el vendedor ahora mismo; el resto de la fila es contexto.
function outstanding(item: PendingListItem): { toInvoice: number; toDeliver: number } {
  const ready = item.inventoryReadyQuantity ?? 0;
  const invoiced = item.invoicedQuantity ?? 0;
  return {
    toInvoice: Math.max(ready - invoiced, 0),
    toDeliver: Math.max(
      Math.min(invoiced, ready, item.quantity) - item.deliveredQuantity,
      0,
    ),
  };
}

// El aviso que le faltaba al vendedor. Sin esto un pendiente se ve EXACTAMENTE
// igual antes y después de que su mercancía llegue a bodega: el sistema ya sabe
// que puede facturar, pero no se lo dice a nadie, y el cliente espera de más.
// Va como texto además de color porque estas filas se leen en un celular al sol.
function fulfillmentNotice(
  item: PendingListItem,
): { label: string; tone: "success" | "primary" } | null {
  if (isTerminal(item)) return null;
  const { toInvoice, toDeliver } = outstanding(item);
  if (toInvoice > 0) {
    return {
      label:
        toInvoice < item.quantity
          ? `Disponible para facturar: ${toInvoice} de ${item.quantity}`
          : "Disponible para facturar",
      tone: "success",
    };
  }
  if (toDeliver > 0) return { label: "Facturado · listo para entregar", tone: "primary" };
  return null;
}

// El panel comercial solo aparece cuando hay una decisión real que tomar:
// o ya se contactó al cliente, o acaba de llegar mercancía para facturarle.
function showsCustomerActions(item: PendingListItem): boolean {
  return item.customerStatus !== "POR_CONTACTAR" || outstanding(item).toInvoice > 0;
}

// El control de gestión se ofrece SIEMPRE que el estado lo admita, no solo
// cuando el pendiente está virgen. Antes el listado mostraba el estado y punto:
// para cambiar un "Solicitado" a "Agotado" había que irse a la vista detallada,
// justo la que gerencia no usa. El listado es la vista principal; tiene que
// poder resolver ahí mismo.
function canManage(item: PendingListItem): boolean {
  if (item.status === "PARCIAL" || isTerminal(item)) return false;
  return canSetManagementStatus(item.purchaseStatus ?? "POR_PEDIR");
}

export function PendingCompactList({
  items,
  canOrder,
  nextCursor,
  pageHref,
  canDeliver = false,
  canContactOrInvoice = false,
}: PendingCompactListProps) {
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={ClipboardCheck}
          title="No hay pendientes"
          description="Todo al día: no queda ningún pendiente por atender."
        />
      </Card>
    );
  }

  const now = new Date();

  return (
    <div className="space-y-3">
      {/* Celular: una fila por pendiente, apilada y sin scroll horizontal. */}
      <div className="space-y-2 lg:hidden">
        {items.map((pending) => {
          const urgency = URGENCY[
            computeDeadlineStatus(pending.promisedAt, pending.status, now)
          ];
          const notice = fulfillmentNotice(pending);
          return (
            <Card key={pending.id} className="space-y-2 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-text">
                    {pending.product.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {pending.createdBy?.name ?? "Sin vendedor"}
                    {" · "}
                    {formatBogotaDate(pending.promisedAt, { style: "date" })}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <p className="font-bold tabular-nums text-text">
                    {pending.quantity}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {pending.product.unit}
                    </span>
                  </p>
                  <Badge tone={urgency.tone}>{urgency.label}</Badge>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {managementLabel(pending)}
                </span>
                {canOrder && canManage(pending) ? (
                  <PendingManagementStatusForm
                    pendingId={pending.id}
                    currentStatus={pending.purchaseStatus ?? "POR_PEDIR"}
                    hideCurrentLabel
                  />
                ) : null}
              </div>
              {notice ? (
                <Badge tone={notice.tone} className="w-full justify-center">
                  {notice.label}
                </Badge>
              ) : null}
              {canContactOrInvoice || canDeliver ? (
                <div className="flex flex-wrap gap-2 border-t border-border pt-2">
                  {canContactOrInvoice && showsCustomerActions(pending) ? (
                    <PendingCustomerLifecycleForm
                      pendingId={pending.id}
                      customerStatus={pending.customerStatus}
                      availableQuantity={pending.inventoryReadyQuantity ?? 0}
                      invoicedQuantity={pending.invoicedQuantity ?? 0}
                    />
                  ) : null}
                  {canDeliver && pending.customerStatus === "FACTURADO" ? (
                    <PendingDeliverForm
                      pendingId={pending.id}
                      remaining={outstanding(pending).toDeliver}
                    />
                  ) : null}
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      {/* Escritorio: la tabla que pidió el gerente. Seis columnas y nada más. */}
      <Card className="hidden overflow-x-auto p-0 lg:block">
        <table className="w-full min-w-[48rem] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Producto</th>
              <th className="px-3 py-2 font-medium">Cantidad</th>
              <th className="px-3 py-2 font-medium">Vendedor</th>
              <th className="px-3 py-2 font-medium">Para</th>
              <th className="px-3 py-2 font-medium">Estado</th>
              {canOrder || canContactOrInvoice || canDeliver ? (
                <th className="px-3 py-2 text-right font-medium">Acción</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {items.map((pending) => {
              const urgency = URGENCY[
                computeDeadlineStatus(pending.promisedAt, pending.status, now)
              ];
              const notice = fulfillmentNotice(pending);
              return (
                <tr key={pending.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-medium text-text">
                    {pending.product.name}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    {pending.quantity} {pending.product.unit}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {pending.createdBy?.name ?? "—"}
                  </td>
                  <td className={cn("px-3 py-2", urgency.tone === "danger" && "font-semibold text-danger")}>
                    {formatBogotaDate(pending.promisedAt, { style: "date" })}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-1">
                      <Badge tone={isManagementStatus(pending.purchaseStatus ?? "POR_PEDIR") ? "primary" : "neutral"}>
                        {managementLabel(pending)}
                      </Badge>
                      {notice ? <Badge tone={notice.tone}>{notice.label}</Badge> : null}
                    </div>
                  </td>
                  {canOrder || canContactOrInvoice || canDeliver ? (
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-2">
                        {canManage(pending) ? (
                          <PendingManagementStatusForm
                            pendingId={pending.id}
                            currentStatus={pending.purchaseStatus ?? "POR_PEDIR"}
                            hideCurrentLabel
                          />
                        ) : null}
                        {canContactOrInvoice && showsCustomerActions(pending) ? (
                          <PendingCustomerLifecycleForm
                            pendingId={pending.id}
                            customerStatus={pending.customerStatus}
                            availableQuantity={pending.inventoryReadyQuantity ?? 0}
                            invoicedQuantity={pending.invoicedQuantity ?? 0}
                          />
                        ) : null}
                        {canDeliver && pending.customerStatus === "FACTURADO" ? (
                          <PendingDeliverForm
                            pendingId={pending.id}
                            remaining={outstanding(pending).toDeliver}
                          />
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

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

import Link from "next/link";
import { ClipboardCheck } from "lucide-react";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { PendingStatus } from "@/lib/generated/prisma/client";
import type {
  PendingListItem,
  PendingScope,
} from "@/server/repositories/pending.repository";
import {
  computeDeadlineStatus,
  type DeadlineStatus,
} from "./deadline-status";
import { formatCop } from "@/lib/format/currency";
import { formatPhone } from "./phone";
import { remainingQuantity } from "./delivery-rules";
import { canSetManagementStatus } from "./management-status";
import {
  derivePaymentState,
  remainingAmount,
  type PaymentState,
} from "./payment-state";
import { PendingCancelForm } from "./pending-cancel-form";
import { PendingDeliverForm } from "./pending-deliver-form";
import { PendingManagementStatusForm } from "./pending-management-status-form";
import { PendingCustomerLifecycleForm } from "./pending-customer-lifecycle-form";

type PendingListProps = {
  items: PendingListItem[];
  nextCursor: string | null;
  // Booleanos explícitos (no un prop de rol): la UI es cosmética, la Server
  // Action re-chequea la capability del lado del server siempre.
  canDeliver: boolean;
  canCancel: boolean;
  // Autoridad de compras (`canOrderMissingItems`): habilita el selector de
  // estado de gestión. El vendedor no lo tiene y solo ve el badge.
  canManageStatus: boolean;
  canContactOrInvoice?: boolean;
  // El scope viaja en el link de la página siguiente: sin esto, paginar dentro
  // del historial devolvería al usuario a la vista activa sin avisar.
  scope: PendingScope;
};

// Estados terminales: ya no hay nada operativo que hacer sobre el pendiente.
const CLOSED_STATUSES: readonly PendingStatus[] = ["ENTREGADO", "CANCELADO"];

const STATUS: Record<
  PendingStatus,
  { label: string; tone: "neutral" | "primary" | "success" | "warning" | "danger" }
> = {
  PENDIENTE: { label: "Pendiente", tone: "warning" },
  PARCIAL: { label: "Parcial", tone: "primary" },
  ENTREGADO: { label: "Entregado", tone: "success" },
  CANCELADO: { label: "Cancelado", tone: "neutral" },
  // Estados de gestión (Mejora 2). "Solicitado" ya está pedido → informativo.
  // "En búsqueda"/"Cotizando" siguen en curso → warning. "Agotado" es un
  // producto que no se consigue → danger, para que el vendedor lo distinga.
  SOLICITADO: { label: "Solicitado", tone: "primary" },
  BUSQUEDA: { label: "En búsqueda", tone: "warning" },
  COTIZANDO: { label: "Cotizando", tone: "warning" },
  AGOTADO: { label: "Agotado", tone: "danger" },
};

// Semáforo operativo: el déficit de tiempo respecto de la promesa de entrega.
const DEADLINE: Record<
  DeadlineStatus,
  { label: string; tone: "neutral" | "success" | "warning" | "danger" }
> = {
  VENCIDO: { label: "Vencido", tone: "danger" },
  VENCE_PRONTO: { label: "Vence pronto", tone: "warning" },
  A_TIEMPO: { label: "A tiempo", tone: "success" },
  FINALIZADO: { label: "Finalizado", tone: "neutral" },
};

// Estado de pago. "Sin abono" no lleva badge: es el caso por defecto y un badge
// gris en cada tarjeta sería ruido que compite con el semáforo de la promesa.
const PAYMENT: Record<
  Exclude<PaymentState, "SIN_ABONO">,
  { label: string; tone: "primary" | "success" }
> = {
  ABONADO: { label: "Abonó", tone: "primary" },
  PAGADO: { label: "Pagado", tone: "success" },
};

// Promesa en hora de Colombia: formatBogotaDate garantiza zona y locale consistentes.

// Listado presentacional (server component). Mobile-first: tarjetas apiladas.
// Las acciones de entrega/cancelación son client components: necesitan
// `useActionState` para mostrar el rechazo que devuelve la Server Action.
export function PendingList({
  items,
  nextCursor,
  canDeliver,
  canCancel,
  canManageStatus,
  canContactOrInvoice = false,
  scope,
}: PendingListProps) {
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={ClipboardCheck}
          title={
            scope === "history"
              ? "No hay pendientes en el historial"
              : "No hay pendientes abiertos"
          }
          description={
            scope === "history"
              ? "Todavía no se entregó ni canceló ningún pendiente."
              : "Todo al día: no queda ningún pendiente por atender."
          }
        />
      </Card>
    );
  }

  // Un único "ahora" para todo el render: semáforo coherente entre tarjetas.
  const now = new Date();

  return (
    <div className="space-y-3">
      {items.map((pending) => {
        const status = STATUS[pending.status];
        const deadline =
          DEADLINE[computeDeadlineStatus(pending.promisedAt, pending.status, now)];
        const isOpen = !CLOSED_STATUSES.includes(pending.status);
        const remaining = remainingQuantity(pending.quantity, pending.deliveredQuantity);
        // Selector de gestión: solo compras, y solo mientras el estado lo admita.
        const showManagement =
          canManageStatus && canSetManagementStatus(pending.purchaseStatus ?? pending.status);
        const showDeliverCancel = isOpen && (canDeliver || canCancel);
        // Filas previas a las columnas nuevas conservan su render histórico; las
        // filas nuevas siempre traen customerStatus y exigen FACTURADO.
        const canDeliverNow = canDeliver && (pending.customerStatus === "FACTURADO" || pending.customerStatus === undefined);
        // Estado de pago derivado de los montos, nunca de una columna guardada.
        const paymentState = derivePaymentState(pending);
        const balance = remainingAmount(pending);
        const payment = paymentState === "SIN_ABONO" ? null : PAYMENT[paymentState];

        return (
          <Card key={pending.id} className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold text-text">
                  {pending.product.name}
                </p>
                <p className="text-sm text-muted-foreground">
                  {pending.quantity} {pending.product.unit} · {pending.product.code}
                  {pending.customerName ? ` · ${pending.customerName}` : ""}
                </p>
                {/* Teléfono: es el dato con el que se avisa que llegó, así que
                    va en la tarjeta y no escondido. Los pendientes anteriores a
                    que fuera obligatorio no lo tienen. */}
                {pending.customerPhone ? (
                  <p className="text-sm text-muted-foreground">
                    Tel: {formatPhone(pending.customerPhone)}
                  </p>
                ) : null}
                {/* Promesa y zona JUNTAS: gerencia prioriza leyendo las dos a la
                    vez (pedido explícito), no buscando la zona en otra línea. */}
                <p className="text-sm text-muted-foreground">
                  Promesa: {formatBogotaDate(pending.promisedAt, { style: "datetime" })}
                  {pending.zone ? ` · ${pending.zone}` : ""}
                </p>
                {/* Dirección de entrega: dónde llevarlo. Los pendientes sin
                    dirección (opcional, o anteriores al campo) no muestran nada. */}
                {pending.customerAddress ? (
                  <p className="text-sm text-muted-foreground">
                    Dirección: {pending.customerAddress}
                  </p>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  Entregado: {pending.deliveredQuantity} / {pending.quantity}{" "}
                  {pending.product.unit}
                </p>
                {/* Quién lo anotó: gerencia lo necesita para saber a nombre de
                    quién va la venta y quién factura. */}
                {pending.createdBy ? (
                  <p className="text-sm text-muted-foreground">
                    Anotado por {pending.createdBy.name}
                  </p>
                ) : null}
                {/* El saldo es lo que hay que COBRAR al entregar: se muestra en
                    la tarjeta, no escondido detrás de un badge. */}
                {paymentState === "SIN_ABONO" ? null : (
                  <p className="text-sm text-muted-foreground">
                    Abonó {formatCop(pending.paidAmount)}
                    {pending.totalAmount === null
                      ? " · valor total sin acordar"
                      : ` de ${formatCop(pending.totalAmount)}`}
                    {balance !== null && balance > 0
                      ? ` · saldo ${formatCop(balance)}`
                      : ""}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <Badge tone={deadline.tone}>{deadline.label}</Badge>
                <Badge tone={status.tone}>{status.label}</Badge>
                {payment ? <Badge tone={payment.tone}>{payment.label}</Badge> : null}
              </div>
            </div>

            {showManagement || showDeliverCancel ? (
              <div className="flex flex-col gap-3 border-t border-border pt-3">
                 {showManagement ? (
                  <PendingManagementStatusForm
                    pendingId={pending.id}
                    currentStatus={pending.purchaseStatus ?? pending.status}
                  />
                 ) : null}
                {/* Facturar: mismo criterio que el listado. No se le exige al
                    vendedor esperar a que el sistema vea llegar la mercancía. */}
                {canContactOrInvoice ? (
                  <PendingCustomerLifecycleForm
                    pendingId={pending.id}
                    customerStatus={pending.customerStatus}
                    quantity={pending.quantity}
                    invoicedQuantity={pending.invoicedQuantity ?? 0}
                  />
                ) : null}
                {showDeliverCancel ? (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    {canDeliverNow ? (
                      <PendingDeliverForm
                        pendingId={pending.id}
                        // Se entrega lo facturado y no entregado; el techo sigue
                        // siendo lo que el cliente pidió.
                        remaining={
                          pending.invoicedQuantity === undefined
                            ? remaining
                            : Math.min(
                                remaining,
                                Math.max(pending.invoicedQuantity - pending.deliveredQuantity, 0),
                              )
                        }
                      />
                    ) : null}
                    {canCancel ? <PendingCancelForm pendingId={pending.id} /> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </Card>
        );
      })}

      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link
            href={`/pendientes?cursor=${encodeURIComponent(nextCursor)}${
              scope === "history" ? "&scope=history" : ""
            }`}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}

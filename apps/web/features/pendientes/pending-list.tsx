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
import { deliverySummary, remainingQuantity } from "./delivery-rules";
import { canSetManagementStatus } from "./management-status";
import {
  fulfillmentNotice,
  invoiceAffordance,
  type PendingViewer,
} from "./fulfillment-notice";
import { identityWarning } from "./identity-warning";
import { pendingAnchorId } from "./pending-anchor";
import { PRESENTATION_LABEL, presentationLabel } from "./presentation";
import { paymentMethodLabel } from "./payment-method";
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
  // Quién mira. Reemplaza al viejo `canContactOrInvoice`, que era un booleano
  // de rol: no sabía de quién era la fila, así que no podía distinguir un
  // pendiente propio de uno ajeno ni un pendiente cargado de uno sin stock.
  viewer: PendingViewer;
  // El scope decide qué acciones tienen sentido sobre la fila.
  scope: PendingScope;
  // El enlace a la página siguiente lo arma la página, que es la que conoce la
  // vista completa: scope, formato y filtros de eje. Cuando esta lista lo
  // construía sola, cada parámetro nuevo se perdía al paginar.
  pageHref: (nextCursor: string) => string;
};

// Estados terminales: ya no hay nada operativo que hacer sobre el pendiente.
// T2.2b: el cierre parcial también es terminal (se resolvió en el mostrador).
const CLOSED_STATUSES: readonly PendingStatus[] = ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"];

const STATUS: Record<
  PendingStatus,
  { label: string; tone: "neutral" | "primary" | "success" | "warning" | "danger" }
> = {
  PENDIENTE: { label: "Pendiente", tone: "warning" },
  PARCIAL: { label: "Parcial", tone: "primary" },
  ENTREGADO: { label: "Entregado", tone: "success" },
  CANCELADO: { label: "Cancelado", tone: "neutral" },
  // T2.2b: hubo entrega parcial y el resto se cerró con el cliente. Tone danger
  // para que se distinga de una entrega completa en el historial.
  CLOSED_PARTIAL: { label: "Cerrado parcial", tone: "danger" },
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
  viewer,
  scope,
  pageHref,
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
        // T4.3: evidencia de cierre para el historial. `closedAt` es la fecha de
        // cierre (última entrega, o la de cierre cuando no hay entregas); se
        // calcula aparte para que el guard del render afine el tipo.
        const lastDelivery = pending.deliveries?.at(-1) ?? null;
        const closedAt = lastDelivery?.deliveredAt ?? pending.completedAt ?? null;
        // Filas previas a las columnas nuevas conservan su render histórico; las
        // filas nuevas siempre traen customerStatus y exigen FACTURADO.
        const canDeliverNow = canDeliver && (pending.customerStatus === "FACTURADO" || pending.customerStatus === undefined);
        // Estado de pago derivado de los montos, nunca de una columna guardada.
        const paymentState = derivePaymentState(pending);
        const balance = remainingAmount(pending);
        const payment = paymentState === "SIN_ABONO" ? null : PAYMENT[paymentState];
        // El aviso de que la mercancía llegó. Es la razón por la que alguien
        // abre esta pantalla: saber sobre cuáles ya se puede actuar.
        const notice = fulfillmentNotice(pending);
        const identityNotice = identityWarning(pending);

        return (
          <Card
            key={pending.id}
            // Destino del enlace "Ver el pendiente" del aviso de llegada: esta
            // es la lista de Revisión, la mesa donde se factura. `scroll-mt-20`
            // deja aire para el topbar sticky (h-16).
            id={pendingAnchorId(pending.id)}
            className="scroll-mt-20 space-y-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words font-semibold text-text">
                  {pending.product.name}
                </p>
                <p className="text-sm text-muted-foreground">
                  {pending.quantity} {pending.product.unit} · {pending.product.code}
                  {pending.customerName ? ` · ${pending.customerName}` : ""}
                </p>
                {/* La presentación del producto: frasco, sobre, caja. Es
                    informativa y NO se edita desde acá —el catálogo es
                    compartido y esta es una pantalla de revisión—. Se muestra
                    siempre, también cuando falta: "Sin presentación" dice que
                    el producto no la tiene, y un renglón ausente no distingue
                    eso de un dato que no llegó a la pantalla.

                    Sirve para los DOS orígenes sin ramificar: lo que el
                    vendedor escribió como producto manual quedó guardado en
                    `product.unit` al crearlo. */}
                <p className="text-sm text-muted-foreground">
                  {PRESENTATION_LABEL}: {presentationLabel(pending.product.unit)}
                </p>
                {/* El laboratorio pedido va con el PRODUCTO, no con el
                    cliente: es lo que decide qué presentación comprar. Los
                    pendientes sin marca pedida no muestran la línea. */}
                {pending.requestedLaboratory ? (
                  <p className="text-sm text-muted-foreground">
                    Lab: {pending.requestedLaboratory.name}
                  </p>
                ) : null}
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
                {/* T4.2b·B: la línea explica la ecuación del cierre parcial
                    (entregado + cancelado = pedido). Antes "Entregado: 3 / 5"
                    dejaba muda la cantidad que el cliente ya no espera. */}
                <p className="text-sm text-muted-foreground">
                  {deliverySummary({
                    status: pending.status,
                    quantity: pending.quantity,
                    deliveredQuantity: pending.deliveredQuantity,
                    cancelledQuantity: pending.cancelledQuantity,
                    unit: pending.product.unit,
                  })}
                </p>
                {/* T4.3: el historial audita CÓMO se cerró, no solo que se
                    cerró. Un ENTREGADO dice quién entregó y cuándo; un
                    CANCELADO, quién, cuándo y el motivo; un cierre parcial, la
                    fecha. Los registros anteriores a estas columnas no tienen
                    el dato y no muestran la línea: no se inventa la historia. */}
                {scope === "history" && pending.status === "ENTREGADO" && closedAt && (
                  <p className="text-sm text-muted-foreground">
                    Entregado por{" "}
                    {lastDelivery?.deliveredBy?.name ?? pending.createdBy?.name ?? "…"} el{" "}
                    {formatBogotaDate(closedAt, { style: "datetime" })}
                  </p>
                )}
                {scope === "history" && pending.status === "CANCELADO" && pending.cancelledAt && (
                  <p className="text-sm text-muted-foreground">
                    Cancelado por {pending.cancelledBy?.name ?? pending.createdBy?.name ?? "…"} el{" "}
                    {formatBogotaDate(pending.cancelledAt, { style: "datetime" })}
                    {pending.cancelReason ? ` · ${pending.cancelReason}` : ""}
                  </p>
                )}
                {scope === "history" && pending.status === "CLOSED_PARTIAL" && pending.completedAt && (
                  <p className="text-sm text-muted-foreground">
                    Cerrado el {formatBogotaDate(pending.completedAt, { style: "datetime" })}
                  </p>
                )}
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
                    {/* Solo cuando se registró: los pendientes anteriores a la
                        columna tienen abono sin medio, y escribir algo ahí
                        —"efectivo", "sin dato"— afirmaría sobre plata real algo
                        que nadie sabe. Se calla, que es lo único cierto. */}
                    {pending.paymentMethod
                      ? ` · ${paymentMethodLabel(pending.paymentMethod)}`
                      : ""}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <Badge tone={deadline.tone}>{deadline.label}</Badge>
                <Badge tone={status.tone}>{status.label}</Badge>
                {payment ? <Badge tone={payment.tone}>{payment.label}</Badge> : null}
                {/* Se apaga solo el día que alguien le cargue el código al
                    producto: la condición se deriva del estado actual, no de
                    un flag guardado en esta fila. */}
                {identityNotice ? <Badge tone="warning">{identityNotice}</Badge> : null}
              </div>
            </div>

            {/* Renglón propio, ancho completo: la etiqueta del aviso es larga
                ("Cargado: 4 de 10 · podés facturar") y en la columna de badges
                apretaría el nombre del producto, que es lo que #157 acaba de
                dejar de cortar en el celular. */}
            {notice ? (
              <Badge tone={notice.tone} className="w-full justify-center">
                {notice.label}
              </Badge>
            ) : null}

            {showManagement || showDeliverCancel ? (
              <div className="flex flex-col gap-3 border-t border-border pt-3">
                 {showManagement ? (
                  <PendingManagementStatusForm
                    pendingId={pending.id}
                    currentStatus={pending.purchaseStatus ?? pending.status}
                  />
                 ) : null}
                {/* Facturar: mismo criterio que el listado, y el MISMO que usa
                    el aviso de la fila. Solo se ofrece si esta persona puede
                    facturar este pendiente y hay mercadería cargada; el service
                    vuelve a comprobar las dos cosas. */}
                {invoiceAffordance(pending, viewer).canInvoice ? (
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
          <Link prefetch={false}
            href={pageHref(nextCursor)}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}

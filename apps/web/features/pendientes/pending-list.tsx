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
import { remainingQuantity } from "./delivery-rules";
import { canSetManagementStatus } from "./management-status";
import { PendingCancelForm } from "./pending-cancel-form";
import { PendingDeliverForm } from "./pending-deliver-form";
import { PendingManagementStatusForm } from "./pending-management-status-form";

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
          canManageStatus && canSetManagementStatus(pending.status);
        const showDeliverCancel = isOpen && (canDeliver || canCancel);

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
                <p className="text-sm text-muted-foreground">
                  Promesa: {formatBogotaDate(pending.promisedAt, { style: "datetime" })}
                </p>
                <p className="text-sm text-muted-foreground">
                  Entregado: {pending.deliveredQuantity} / {pending.quantity}{" "}
                  {pending.product.unit}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <Badge tone={deadline.tone}>{deadline.label}</Badge>
                <Badge tone={status.tone}>{status.label}</Badge>
              </div>
            </div>

            {showManagement || showDeliverCancel ? (
              <div className="flex flex-col gap-3 border-t border-border pt-3">
                {showManagement ? (
                  <PendingManagementStatusForm
                    pendingId={pending.id}
                    currentStatus={pending.status}
                  />
                ) : null}
                {showDeliverCancel ? (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    {canDeliver ? (
                      <PendingDeliverForm pendingId={pending.id} remaining={remaining} />
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

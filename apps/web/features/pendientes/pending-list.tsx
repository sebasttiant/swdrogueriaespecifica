import Link from "next/link";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import type { PendingStatus } from "@/lib/generated/prisma/client";
import type { PendingListItem } from "@/server/repositories/pending.repository";
import {
  computeDeadlineStatus,
  type DeadlineStatus,
} from "./deadline-status";

type PendingListProps = {
  items: PendingListItem[];
  nextCursor: string | null;
};

const STATUS: Record<
  PendingStatus,
  { label: string; tone: "neutral" | "primary" | "success" | "warning" }
> = {
  PENDIENTE: { label: "Pendiente", tone: "warning" },
  PARCIAL: { label: "Parcial", tone: "primary" },
  ENTREGADO: { label: "Entregado", tone: "success" },
  CANCELADO: { label: "Cancelado", tone: "neutral" },
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

// Promesa en hora de Colombia: el negocio es operativo en esa zona.
const promiseFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "short",
  timeStyle: "short",
});

// Listado presentacional (server component). Mobile-first: tarjetas apiladas.
export function PendingList({ items, nextCursor }: PendingListProps) {
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-base text-muted-foreground">
          Todavía no hay pendientes registrados.
        </p>
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
        return (
          <Card key={pending.id} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-semibold text-text">
                {pending.product.name}
              </p>
              <p className="text-sm text-muted-foreground">
                {pending.quantity} {pending.product.unit} · {pending.product.code}
                {pending.customerName ? ` · ${pending.customerName}` : ""}
              </p>
              <p className="text-sm text-muted-foreground">
                Promesa: {promiseFormatter.format(pending.promisedAt)}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <Badge tone={deadline.tone}>{deadline.label}</Badge>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
          </Card>
        );
      })}

      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link
            href={`/pendientes?cursor=${encodeURIComponent(nextCursor)}`}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}

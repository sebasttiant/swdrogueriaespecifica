import Link from "next/link";
import { PackageCheck } from "lucide-react";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { MissingItemStatus } from "@/lib/generated/prisma/client";
import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";
import {
  computeDeadlineStatus,
  type DeadlineStatus,
} from "../pendientes/deadline-status";

type MissingListProps = {
  items: MissingItemListItem[];
  nextCursor: string | null;
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

// Listado presentacional (server component). Mobile-first: tarjetas apiladas.
export function MissingList({ items, nextCursor }: MissingListProps) {
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

  const now = new Date();

  return (
    <div className="space-y-3">
      {items.map((missing) => {
        const status = STATUS[missing.status];
        const origin = missing.origin;
        const deadline = origin
          ? DEADLINE[computeDeadlineStatus(origin.promisedAt, origin.status, now)]
          : null;
        return (
          <Card key={missing.id} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-semibold text-text">
                {missing.product.name}
              </p>
              <p className="text-sm text-muted-foreground">
                Faltan {missing.quantity} {missing.product.unit} ·{" "}
                {missing.product.code}
                {missing.originId ? " · auto" : ""}
              </p>
              {origin ? (
                <div className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                  <p>
                    Origen: pendiente · {origin.customerName ?? origin.id}
                  </p>
                  <p>
                    Promesa: {formatBogotaDate(origin.promisedAt, { style: "datetime" })}
                  </p>
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              {deadline ? <Badge tone={deadline.tone}>{deadline.label}</Badge> : null}
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
          </Card>
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

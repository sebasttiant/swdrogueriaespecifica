import Link from "next/link";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import type { PendingStatus } from "@/lib/generated/prisma/client";
import type { PendingListItem } from "@/server/repositories/pending.repository";

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

  return (
    <div className="space-y-3">
      {items.map((pending) => {
        const status = STATUS[pending.status];
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
            </div>
            <Badge tone={status.tone}>{status.label}</Badge>
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

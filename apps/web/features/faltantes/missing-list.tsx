import Link from "next/link";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import type { MissingItemStatus } from "@/lib/generated/prisma/client";
import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

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

// Listado presentacional (server component). Mobile-first: tarjetas apiladas.
export function MissingList({ items, nextCursor }: MissingListProps) {
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-base text-muted-foreground">
          No hay faltantes por ahora.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((missing) => {
        const status = STATUS[missing.status];
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
            </div>
            <Badge tone={status.tone}>{status.label}</Badge>
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

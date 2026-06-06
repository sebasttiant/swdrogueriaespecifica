import Link from "next/link";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import { expiryLevel, isAgotado } from "@/lib/inventory/batch-status";
import type { BatchListItem } from "@/server/repositories/product-batch.repository";

type BatchListProps = {
  productId: string;
  items: BatchListItem[];
  nextCursor: string | null;
};

const EXPIRY_TONE = {
  ok: "success",
  warning: "warning",
  expired: "danger",
} as const;

const EXPIRY_LABEL = {
  ok: "Vigente",
  warning: "Por vencer",
  expired: "Vencido",
} as const;

function formatDate(date: Date): string {
  return date.toLocaleDateString("es-AR");
}

// Listado de lotes con semáforo de vencimiento DERIVADO en lectura.
export function BatchList({ productId, items, nextCursor }: BatchListProps) {
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-base text-muted-foreground">
          Este producto todavía no tiene lotes cargados.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((batch) => {
        const level = expiryLevel(batch.expiresAt);
        return (
          <Card key={batch.id} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="truncate font-semibold text-text">
                Lote {batch.batchCode}
              </p>
              <Badge tone={EXPIRY_TONE[level]}>{EXPIRY_LABEL[level]}</Badge>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span>Vence: {formatDate(batch.expiresAt)}</span>
              <span>Cantidad: {batch.quantity}</span>
              {batch.location ? <span>Ubicación: {batch.location}</span> : null}
              <span>Estado: {batch.status}</span>
              {isAgotado(batch.quantity) ? (
                <span className="font-medium text-danger">Agotado</span>
              ) : null}
            </div>
          </Card>
        );
      })}

      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link
            href={`/productos/${productId}?cursor=${encodeURIComponent(nextCursor)}`}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}

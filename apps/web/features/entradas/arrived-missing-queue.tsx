import Link from "next/link";

import { Card, CardTitle } from "@/app/_components/ui/card";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { ArrivedMissingItem } from "@/server/repositories/missing-item.repository";

export function ArrivedMissingQueue({ items }: { items: ArrivedMissingItem[] }) {
  if (items.length === 0) return null;
  return (
    <Card className="space-y-3">
      <CardTitle>Pendiente por cargar ({items.length})</CardTitle>
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium text-text">{item.product.name}</p>
              <p className="text-xs text-muted-foreground">
                {item.product.code} · Llegó {item.arrivedAt ? formatBogotaDate(item.arrivedAt, { style: "datetime" }) : "sin fecha"}
                {item.requestedByName ? ` · Reportado por ${item.requestedByName}` : ""}
              </p>
            </div>
            <Link href={`/entradas?productId=${encodeURIComponent(item.productId)}`} className="inline-flex min-h-11 items-center font-semibold text-primary hover:underline">
              Cargar entrada
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

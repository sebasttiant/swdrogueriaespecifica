import Link from "next/link";
import { PackagePlus } from "lucide-react";

import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { InventoryEntryListItem } from "@/server/repositories/inventory-entry.repository";

type EntryListProps = {
  items: InventoryEntryListItem[];
  nextCursor: string | null;
};

// Listado presentacional (server component). Mobile-first: tarjetas apiladas.
export function EntryList({ items, nextCursor }: EntryListProps) {
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={PackagePlus}
          title="Sin entradas registradas"
          description="Todavía no se registraron entradas de inventario."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((entry) => (
        <Card key={entry.id} className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words font-semibold text-text">
              {entry.product.name}
            </p>
            <p className="text-sm text-muted-foreground">
              {entry.quantity} unidades · {entry.product.code}
            </p>
            {entry.note ? (
              <p className="text-sm text-muted-foreground">{entry.note}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {formatBogotaDate(entry.createdAt, { style: "datetime" })}
              {entry.createdBy?.name ? ` · ${entry.createdBy.name}` : ""}
            </p>
          </div>
        </Card>
      ))}

      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link
            href={`/entradas?cursor=${encodeURIComponent(nextCursor)}`}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}

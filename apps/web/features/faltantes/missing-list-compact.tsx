import { PackageCheck } from "lucide-react";

import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import type { MissingItemListEntry } from "@/server/services/missing-item.service";

type MissingListCompactProps = {
  items: MissingItemListEntry[];
};

// Vista compacta (Mejora 3): solo lo esencial para escanear o imprimir la cola —
// producto, laboratorio, cantidad. Sin badges, acciones ni detalle. NO reemplaza
// la vista completa (`MissingList`): es una alternativa que se elige por ?view.
export function MissingListCompact({ items }: MissingListCompactProps) {
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={PackageCheck}
          title="Sin faltantes"
          description="No hay faltantes abiertos por ahora."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Mobile: filas apiladas y compactas. */}
      <div className="space-y-2 lg:hidden">
        {items.map((item) => (
          <Card
            key={item.id}
            className="flex items-start justify-between gap-3 p-3"
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-text">{item.product.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {item.product.laboratory?.name ?? "Sin laboratorio"}
              </p>
            </div>
            <p className="shrink-0 font-bold tabular-nums text-text">
              {item.quantity}
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {item.product.unit}
              </span>
            </p>
          </Card>
        ))}
      </div>

      {/* Desktop: tabla simple con scroll horizontal si no entra. */}
      <Card className="hidden overflow-x-auto p-0 lg:block">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Producto</th>
              <th className="px-3 py-2 font-medium">Laboratorio</th>
              <th className="px-3 py-2 font-medium">Cantidad</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2 font-medium text-text">
                  {item.product.name}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {item.product.laboratory?.name ?? "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {item.quantity} {item.product.unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

import { PackageCheck } from "lucide-react";

import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import type { MissingItemListEntry } from "@/server/services/missing-item.service";

type MissingListCompactProps = {
  items: MissingItemListEntry[];
};

// Vista compacta (Mejora 3): solo lo esencial para escanear o imprimir la cola.
// Un faltante manual no tiene déficit: su `quantity = 1` es un sentinel interno;
// en cambio, uno automático sí muestra el déficit calculado desde el pendiente.
function compactReference(item: MissingItemListEntry) {
  if (item.originId === null) {
    return item.sellerCode ? (
      <span className="font-mono">{item.sellerCode}</span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  }

  return (
    <>
      {item.quantity}
      <span className="ml-1 text-xs font-normal text-muted-foreground">
        {item.product.unit}
      </span>
    </>
  );
}

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
              {/* Quién lo anotó: gerencia lo necesita para saber qué vendedor
                  registró el faltante. Es el punto del pedido (F1), así que va
                  también en la vista compacta, no solo en la completa. */}
              {item.requestedByName ? (
                <p className="truncate text-xs text-muted-foreground">
                  Solicitado por {item.requestedByName}
                </p>
              ) : null}
            </div>
            <p className="shrink-0 font-bold tabular-nums text-text">
              {compactReference(item)}
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
              <th className="px-3 py-2 font-medium">Referencia</th>
              <th className="px-3 py-2 font-medium">Solicitado por</th>
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
                  {compactReference(item)}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {item.requestedByName ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

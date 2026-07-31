import Link from "next/link";
import { PackageCheck } from "lucide-react";

import { Badge } from "@/app/_components/ui/badge";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { ArrivedMissingItem } from "@/server/repositories/missing-item.repository";

// --------------------------------------------------------------------------
// Lo que llegó a la droguería y todavía no está cargado al sistema.
//
// Es la lista de trabajo de bodega, y su único objetivo es que cargar una caja
// cueste lo menos posible. Por eso el botón no lleva a un formulario vacío:
// lleva al formulario con el PRODUCTO y la CANTIDAD ya escritos, y salta
// directo a él. A quien recibe le queda solo el lote y el vencimiento, que son
// los dos datos que únicamente él puede leer de la caja.
//
// Deliberadamente sin datos del cliente: bodega no necesita saber para quién es
// para poder guardarlo.
// --------------------------------------------------------------------------

function loadHref(item: ArrivedMissingItem): string {
  const params = new URLSearchParams({
    productId: item.productId,
    quantity: String(item.pendingQuantity),
  });
  return `/entradas?${params.toString()}#nueva-entrada`;
}

export function ArrivedMissingQueue({ items }: { items: ArrivedMissingItem[] }) {
  if (items.length === 0) return null;

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <PackageCheck className="size-5 shrink-0 text-primary" aria-hidden />
        <CardTitle>Pendiente por cargar ({items.length})</CardTitle>
      </div>

      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-text">{item.product.name}</p>
                <Badge tone="primary">{item.pendingQuantity} por cargar</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {item.product.code}
                {" · Llegó "}
                {item.arrivedAt
                  ? formatBogotaDate(item.arrivedAt, { style: "datetime" })
                  : "sin fecha"}
                {item.requestedByName ? ` · Reportado por ${item.requestedByName}` : ""}
              </p>
            </div>

            <Link
              href={loadHref(item)}
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Cargar entrada
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

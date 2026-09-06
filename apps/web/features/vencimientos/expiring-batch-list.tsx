import Link from "next/link";
import { CalendarCheck } from "lucide-react";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import {
  bogotaCalendarDaysUntil,
  type ExpiryTier,
} from "@/lib/inventory/batch-status";
import type { ExpiringBatchListItem } from "@/server/repositories/product-batch.repository";

import {
  EXPIRY_TIER_EMPTY,
  EXPIRY_TIER_TONE,
  expiryCountdownLabel,
  vencimientosHref,
} from "./expiry-tier";

// --------------------------------------------------------------------------
// Los lotes de UNA franja de vencimiento, el que vence antes primero.
//
// Es la pantalla que abre el chip de la barra de alertas, y por eso muestra
// LOTES y no productos: lo que vence es el lote. Un listado de productos
// obligaría a entrar a cada uno para descubrir cuál de sus lotes es el del
// aviso, que es exactamente el paseo que esta pantalla viene a eliminar.
//
// Cinco datos por fila y nada más — producto, lote, fecha, cuánto falta,
// cantidad—: es lo que hace falta para ir al estante y sacarlo.
// --------------------------------------------------------------------------

type ExpiringBatchListProps = {
  tier: ExpiryTier;
  items: ExpiringBatchListItem[];
  nextCursor: string | null;
  // Inyectable para que el test fije el "hoy" y la cuenta de días no dependa
  // del día en que se corra la suite.
  now?: Date;
};

export function ExpiringBatchList({
  tier,
  items,
  nextCursor,
  now = new Date(),
}: ExpiringBatchListProps) {
  if (items.length === 0) {
    const empty = EXPIRY_TIER_EMPTY[tier];
    return (
      <Card>
        <EmptyState
          icon={CalendarCheck}
          title={empty.title}
          description={empty.description}
        />
      </Card>
    );
  }

  const tone = EXPIRY_TIER_TONE[tier];
  const rows = items.map((batch) => ({
    batch,
    days: bogotaCalendarDaysUntil(batch.expiresAt, now),
    date: formatBogotaDate(batch.expiresAt, { style: "date" }),
  }));

  return (
    <div className="space-y-3">
      {/* Celular: una tarjeta por lote. */}
      <div className="space-y-3 lg:hidden">
        {rows.map(({ batch, days, date }) => (
          <Card key={batch.id} className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <Link
                prefetch={false}
                href={`/productos/${batch.product.id}`}
                className="break-words font-semibold text-text hover:underline"
              >
                {batch.product.name}
              </Link>
              <Badge tone={tone}>{expiryCountdownLabel(days)}</Badge>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span>Lote {batch.batchCode}</span>
              <span>Vence: {date}</span>
              <span>
                Cantidad: {batch.quantity} {batch.product.unit}
              </span>
            </div>
          </Card>
        ))}
      </div>

      {/* Escritorio: tabla, con scroll horizontal si no entra. */}
      <Card className="hidden overflow-x-auto p-0 lg:block">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Producto</th>
              <th className="px-3 py-2 font-medium">Lote</th>
              <th className="px-3 py-2 font-medium">Vence</th>
              <th className="px-3 py-2 font-medium">Cuánto falta</th>
              <th className="px-3 py-2 font-medium">Cantidad</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ batch, days, date }) => (
              <tr key={batch.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2 font-medium text-text">
                  <Link
                    prefetch={false}
                    href={`/productos/${batch.product.id}`}
                    className="hover:underline"
                  >
                    {batch.product.name}
                  </Link>
                  <span className="block text-xs text-muted-foreground">
                    {batch.product.code}
                  </span>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{batch.batchCode}</td>
                <td className="px-3 py-2 text-muted-foreground">{date}</td>
                <td className="px-3 py-2">
                  <Badge tone={tone}>{expiryCountdownLabel(days)}</Badge>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {batch.quantity} {batch.product.unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* El "Ver más" conserva la franja: sin el `tier`, la segunda página
          caería en el default y mezclaría lotes de otra ventana. */}
      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link
            prefetch={false}
            href={vencimientosHref({ tier, cursor: nextCursor })}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}

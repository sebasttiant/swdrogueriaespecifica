import Link from "next/link";
import { PackageCheck } from "lucide-react";

import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import type { MissingItemListEntry } from "@/server/services/missing-item.service";

import { missingAttribution } from "./missing-attribution";
import { MissingQuickActions } from "./missing-quick-actions";

type MissingListCompactProps = {
  items: MissingItemListEntry[];
  // Autoridad de compras. Sin esto no se ofrecen los botones ✓/✗ — y la Server
  // Action los rechaza igual, así que esconderlos es cosmética, no seguridad.
  canAct: boolean;
  // Paginación: la vista compacta es la que se usa en el celular con cientos de
  // faltantes. Sin este control la lista terminaba en la primera página y las
  // demás quedaban inalcanzables — parecía que no había más.
  nextCursor: string | null;
  // Se preserva la vista al pasar de página; si no, la página 2 volvería a la
  // lista completa.
  pageHref: (cursor: string) => string;
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

export function MissingListCompact({
  items,
  canAct,
  nextCursor,
  pageHref,
}: MissingListCompactProps) {
  // ¿Hay algo que atribuir en esta página? Decide si la columna existe: en la
  // cola "Por pedir" nadie tocó nada, así que la tabla queda tan corta como
  // antes de este cambio.
  const hasAttribution = items.some((item) => missingAttribution(item) !== null);

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
        {items.map((item) => {
          const attribution = missingAttribution(item);
          return (
            <Card key={item.id} className="space-y-2 p-3">
              <div className="flex items-start justify-between gap-3">
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
                  {/* Quién lo pidió o lo descartó. Son dos personas trabajando
                      la misma cola: sin esto había que preguntarlo por teléfono. */}
                  {attribution ? (
                    <p className="truncate text-xs font-medium text-muted-foreground">
                      {attribution.label} {attribution.name}
                    </p>
                  ) : null}
                </div>
                <p className="shrink-0 font-bold tabular-nums text-text">
                  {compactReference(item)}
                </p>
              </div>
              {/* Solo lo que sigue esperando decisión ofrece acciones: una fila
                  ya pedida o descartada no tiene nada que marcar. */}
              {canAct && attribution === null ? (
                <MissingQuickActions
                  missingItemId={item.id}
                  productName={item.product.name}
                />
              ) : null}
            </Card>
          );
        })}
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
              {/* La columna solo aparece si hay algo que atribuir. En "Por
                  pedir" nadie tocó nada todavía, y la pestaña ya dice el
                  estado: una columna vacía sería ruido en una vista cuya razón
                  de ser es ser corta. */}
              {hasAttribution ? (
                <th className="px-3 py-2 font-medium">Marcado por</th>
              ) : null}
              {canAct ? <th className="px-3 py-2 font-medium">Acciones</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const attribution = missingAttribution(item);
              return (
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
                  {hasAttribution ? (
                    <td className="px-3 py-2 text-muted-foreground">
                      {attribution
                        ? `${attribution.label} ${attribution.name}`
                        : "—"}
                    </td>
                  ) : null}
                  {canAct ? (
                    <td className="px-3 py-2">
                      {attribution === null ? (
                        <MissingQuickActions
                          missingItemId={item.id}
                          productName={item.product.name}
                        />
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* "Ver más" con altura de dedo (44px): esta es la vista del celular. */}
      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link
            href={pageHref(nextCursor)}
            className="inline-flex min-h-11 items-center px-4 text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}

import Link from "next/link";

import { MissingBulkActions } from "@/features/faltantes/missing-bulk-actions";
import { MissingExportActions } from "@/features/faltantes/missing-export-actions";
import { MissingList } from "@/features/faltantes/missing-list";
import { MissingListCompact } from "@/features/faltantes/missing-list-compact";
import { canDiscard } from "@/features/faltantes/order-rules";
import {
  MISSING_SCOPE_EMPTY,
  missingPageHref,
  missingScopeHref,
  type MissingBoardRoute,
  type MissingQueueScope,
} from "@/features/faltantes/missing-scope";
import type { MissingView } from "@/features/faltantes/missing-view";
import { cn } from "@/lib/utils/cn";

// --------------------------------------------------------------------------
// La MESA DE TRABAJO de gerencia: qué pedir, qué descartar, qué ya se pidió.
//
// Vivía dentro de `/faltantes`, mezclada con el alta y el reporte del vendedor.
// Se movió a `/revision-faltantes` porque así se pidió el módulo: gerencia
// revisa ahí para PEDIR, y bodega marca ahí que LLEGÓ. Una sola cola, dos
// tramos: gerencia la empuja de "Por pedir" a "Ya pedidos"; bodega la empuja
// de "Ya pedidos" a "En bodega" y de ahí a la entrada registrada.
//
// `/faltantes` queda como la pantalla de CAPTURA —reportar, ver mis reportes,
// dar de alta—, que es lo que de verdad hace el vendedor. Antes las dos colas
// se llamaban igual y tenían las mismas pestañas sobre modelos distintos, y
// eso hacía parecer que el sistema estaba desacoplado cuando no lo estaba.
//
// Es presentación pura: recibe los datos ya resueltos y no consulta nada. Así
// la página decide el alcance —y quién puede verlo— en un solo lugar.
// --------------------------------------------------------------------------

type MissingQueueBoardProps = {
  items: Parameters<typeof MissingList>[0]["items"];
  nextCursor: string | null;
  scope: MissingQueueScope;
  view: MissingView;
  canAct: boolean;
  canExport: boolean;
  canSeeSupplier: boolean;
  now: Date;
  /** Ruta y nombres de parámetros del tablero. Ver `missing-scope.ts`. */
  route: MissingBoardRoute;
  /** Cómo se llama esta cola para el lector de pantalla. */
  label: string;
};

export function MissingQueueBoard({
  items,
  nextCursor,
  scope,
  view,
  canAct,
  canExport,
  canSeeSupplier,
  now,
  route,
  label,
}: MissingQueueBoardProps) {
  return (
    <div className="space-y-4">
      {/* Toggle de vista (completa/compacta) + export. Se ocultan al imprimir:
          el PDF es la lista, no los controles. */}
      <div className="flex flex-col gap-3 print:hidden sm:flex-row sm:items-center sm:justify-between">
        <nav aria-label={label} className="flex gap-2 text-sm font-semibold">
          {(["full", "compact"] as const).map((option) => (
            <Link
              prefetch={false}
              key={option}
              href={missingScopeHref(scope, option, route)}
              aria-current={view === option ? "page" : undefined}
              className={cn(
                "rounded-lg px-3 py-1.5 transition-colors",
                view === option
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {option === "full" ? "Completa" : "Compacta"}
            </Link>
          ))}
        </nav>

        {/* Export (Excel/CSV/PDF) solo para gerencia. La ruta de descarga
            revalida la capacidad igual: esto solo evita ofrecer el botón. */}
        {canExport ? <MissingExportActions /> : null}
      </div>

      {/* Cierre rápido de duplicados: solo la autoridad de compras. El vendedor
          no ve ni las casillas. Se ofrecen únicamente los faltantes que la
          acción admite, para no mostrar un control que el servidor rechazaría. */}
      {canAct ? (
        <MissingBulkActions
          items={items
            .filter((item) => canDiscard(item.status))
            .map((item) => ({
              id: item.id,
              productName: item.product.name,
              quantity: item.originId ? item.quantity : null,
              unit: item.product.unit,
              sellerCode: item.originId ? null : item.sellerCode,
            }))}
        />
      ) : null}

      {view === "compact" ? (
        <MissingListCompact
          items={items}
          canAct={canAct}
          emptyTitle={MISSING_SCOPE_EMPTY[scope].title}
          emptyDescription={MISSING_SCOPE_EMPTY[scope].description}
          nextCursor={nextCursor}
          pageHref={(next) => missingPageHref(scope, view, next, route)}
        />
      ) : (
        <MissingList
          items={items}
          nextCursor={nextCursor}
          pageHref={(next) => missingPageHref(scope, view, next, route)}
          canQuickAct={canAct}
          canSeeStatus={canAct}
          canSeeSupplier={canSeeSupplier}
          now={now}
        />
      )}
    </div>
  );
}

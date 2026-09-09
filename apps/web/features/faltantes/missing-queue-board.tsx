import Link from "next/link";

import { MissingBulkActions } from "@/features/faltantes/missing-bulk-actions";
import { MissingExportActions } from "@/features/faltantes/missing-export-actions";
import { MissingList } from "@/features/faltantes/missing-list";
import { canDiscard } from "@/features/faltantes/order-rules";
import {
  missingPageHref,
  missingScopeHref,
  type MissingBoardRoute,
  type MissingQueueScope,
} from "@/features/faltantes/missing-scope";
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
//
// La vista compacta se retiró (el dueño la comparó contra la completa con
// datos de producción y convergían): ya no hay toggle de layout acá, solo
// `MissingList`.
// --------------------------------------------------------------------------

type MissingQueueBoardProps = {
  items: Parameters<typeof MissingList>[0]["items"];
  nextCursor: string | null;
  scope: MissingQueueScope;
  canAct: boolean;
  canExport: boolean;
  canSeeSupplier: boolean;
  // Capability `canViewMissingAttribution` (SUPERADMIN/ADMIN): gatea la
  // columna Fecha de la lista. "Solicitado por" sigue visible para todos.
  canSeeRequestedAt: boolean;
  now: Date;
  /** Ruta y nombres de parámetros del tablero. Ver `missing-scope.ts`. */
  route: MissingBoardRoute;
  /** Cómo se llama esta cola para el lector de pantalla. */
  label: string;
  /**
   * Selección masiva: modo alternativo de la MISMA lista, resuelto por la
   * página vía `resolveMissingBulkMode` sobre `route.bulkParam`. Se combina
   * acá abajo con `canAct` — quien arma la página no tiene por qué acordarse
   * de ese gate cada vez que lea este prop.
   */
  bulkMode: boolean;
};

export function MissingQueueBoard({
  items,
  nextCursor,
  scope,
  canAct,
  canExport,
  canSeeSupplier,
  canSeeRequestedAt,
  now,
  route,
  label,
  bulkMode,
}: MissingQueueBoardProps) {
  // Se muestra y se activa SOLO para la autoridad de compras — igual que hoy
  // se monta `MissingBulkActions` — sin importar qué traiga la URL.
  const isBulkMode = canAct && bulkMode;

  // Mismo criterio que ya filtra `missing-queue-board.tsx` de siempre:
  // `canDiscard(item.status)`. Solo para "Seleccionar todos" y el total; NO
  // para dibujar filas, que es trabajo de la lista real.
  const eligibleIds = items
    .filter((item) => canDiscard(item.status))
    .map((item) => item.id);

  const list = (
    <MissingList
      items={items}
      nextCursor={nextCursor}
      pageHref={(next) => missingPageHref(scope, next, route, isBulkMode)}
      canQuickAct={canAct}
      canSeeStatus={canAct}
      canSeeSupplier={canSeeSupplier}
      canSeeRequestedAt={canSeeRequestedAt}
      scope={scope}
      bulkMode={isBulkMode}
      now={now}
    />
  );

  return (
    <div className="space-y-4">
      {/* Selección masiva + export. Se ocultan al imprimir: el PDF es la
          lista, no los controles. */}
      <div className="flex flex-col gap-3 print:hidden sm:flex-row sm:items-center sm:justify-between">
        <nav aria-label={label} className="flex flex-wrap gap-2 text-sm font-semibold">
          {/* Entrar y salir de selección masiva, como enlace de URL —server
              rendered, compartible—. Solo para la autoridad de compras: quien
              no puede despachar en lote no tiene qué hacer con el modo. */}
          {canAct ? (
            <Link
              prefetch={false}
              href={missingScopeHref(scope, route, !isBulkMode)}
              aria-current={isBulkMode ? "page" : undefined}
              className={cn(
                "rounded-lg px-3 py-1.5 transition-colors",
                isBulkMode
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {isBulkMode ? "Salir de selección" : "Seleccionar varios"}
            </Link>
          ) : null}
        </nav>

        {/* Export (Excel/CSV/PDF) solo para gerencia. La ruta de descarga
            revalida la capacidad igual: esto solo evita ofrecer el botón. */}
        {canExport ? <MissingExportActions /> : null}
      </div>

      {/* La barra ENVUELVE la lista real: en modo masivo dibuja UN formulario
          y delega el conteo sobre las casillas que la lista ya monta en cada
          fila. Fuera de modo masivo no se monta nada acá — la lista sola,
          como siempre. */}
      {isBulkMode ? (
        <MissingBulkActions eligibleIds={eligibleIds}>{list}</MissingBulkActions>
      ) : (
        list
      )}
    </div>
  );
}

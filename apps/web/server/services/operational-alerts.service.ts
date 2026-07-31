import type { AlertCounts } from "@/lib/alertas/signature";
import { getExpiringBatchCounts } from "@/server/services/product-batch.service";
import {
  countOverduePendings,
  countUpcomingPendings,
} from "@/server/repositories/pending.repository";
import { countOverdueMissingItems } from "@/server/repositories/missing-item.repository";

const EMPTY_COUNTS: AlertCounts = {
  expiredBatches: 0,
  criticalBatches: 0,
  overdueDeliveries: 0,
  upcomingDeliveries: 0,
  criticalMissing: 0,
};

/**
 * A quién le habla cada aviso.
 *
 * `global` es gerencia: ve el estado de toda la droguería —lotes vencidos,
 * stock crítico, faltantes atrasados y las entregas de todos.
 *
 * `owner` es el vendedor: ve SOLO las entregas que él prometió. Lo demás no es
 * suyo. Un lote por vencer no lo resuelve él, y un faltante lo reporta y lo
 * deja: "coloco mi nombre y dejo que Andrés y don Guillermo hagan lo que
 * quieran con eso".
 *
 * Quien no tiene ninguna de las dos —bodega— no recibe avisos. Antes veía
 * "Próximas 1", que son entregas a clientes: ruido sobre trabajo ajeno.
 */
export type AlertScope =
  | { kind: "global" }
  | { kind: "owner"; ownerId: string }
  | { kind: "none" };

export async function getOperationalAlerts(
  now: Date = new Date(),
  scope: AlertScope = { kind: "global" },
): Promise<AlertCounts> {
  if (scope.kind === "none") return EMPTY_COUNTS;

  if (scope.kind === "owner") {
    const [overdueDeliveries, upcomingDeliveries] = await Promise.all([
      countOverduePendings(now, scope.ownerId),
      countUpcomingPendings(now, scope.ownerId),
    ]);
    return { ...EMPTY_COUNTS, overdueDeliveries, upcomingDeliveries };
  }

  const [expiringCounts, overdueDeliveries, upcomingDeliveries, criticalMissing] =
    await Promise.all([
      getExpiringBatchCounts(now),
      countOverduePendings(now),
      countUpcomingPendings(now),
      countOverdueMissingItems(now),
    ]);

  return {
    expiredBatches: expiringCounts.expired,
    criticalBatches: expiringCounts.critical,
    overdueDeliveries,
    upcomingDeliveries,
    criticalMissing,
  };
}

// Versión cacheada (60s) para la AlertBar, que se renderiza en CADA navegación
// desde el AppShell. Estos avisos son advisory (posponibles 8h), así que 60s de
// desfase es irrelevante y evita recomputar ~5 count-queries por página. La
// alerta de gerencia (crítica) NO se cachea: se mantiene siempre en vivo.
// Sin caché, a propósito.
//
// Antes esto envolvía las consultas en `unstable_cache`. Al acotar los avisos
// por persona hubo que meter el alcance en la clave, y eso obligó a construir
// el wrapper en CADA request en vez de una vez por módulo: justo lo que Next
// no espera, y con la aplicación quedando colgada en "Guardando…" cuando el
// aviso se re-renderizaba dentro de una Server Action.
//
// Son cuatro `count()` sobre columnas indexadas para una droguería con un
// puñado de usuarios. El caché ahorraba milisegundos y costaba que el aviso
// mintiera hasta un minuto después de cada entrega, de cada cancelación y de
// cada reset de datos. Mal negocio.
export function getOperationalAlertsCached(
  scope: AlertScope = { kind: "global" },
): Promise<AlertCounts> {
  return getOperationalAlerts(new Date(), scope);
}

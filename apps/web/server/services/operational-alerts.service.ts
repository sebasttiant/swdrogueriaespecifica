import { unstable_cache } from "next/cache";

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
// El alcance forma parte de la CLAVE de caché, no solo del cálculo. Cachear
// avisos acotados a una persona bajo una clave compartida le serviría a un
// vendedor los pendientes de otro: la privacidad se rompería en el caché, no
// en la consulta.
export function getOperationalAlertsCached(
  scope: AlertScope = { kind: "global" },
): Promise<AlertCounts> {
  const scopeKey = scope.kind === "owner" ? `owner:${scope.ownerId}` : scope.kind;
  return unstable_cache(
    () => getOperationalAlerts(new Date(), scope),
    ["operational-alerts-v2", scopeKey],
    { revalidate: 60 },
  )();
}

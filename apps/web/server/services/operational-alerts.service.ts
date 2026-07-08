import { unstable_cache } from "next/cache";

import type { AlertCounts } from "@/lib/alertas/signature";
import { getExpiringBatchCounts } from "@/server/services/product-batch.service";
import {
  countOverduePendings,
  countUpcomingPendings,
} from "@/server/repositories/pending.repository";
import { countOverdueMissingItems } from "@/server/repositories/missing-item.repository";

export async function getOperationalAlerts(
  now: Date = new Date(),
): Promise<AlertCounts> {
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
export const getOperationalAlertsCached = unstable_cache(
  () => getOperationalAlerts(new Date()),
  ["operational-alerts-v1"],
  { revalidate: 60 },
);

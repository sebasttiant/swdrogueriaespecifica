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

export type AlertCounts = {
  expiredBatches: number;
  criticalBatches: number;
  overdueDeliveries: number;
  upcomingDeliveries: number;
  criticalMissing: number;
};

export function alertSignature(counts: AlertCounts): string {
  return [
    `exp:${counts.expiredBatches}`,
    `crit:${counts.criticalBatches}`,
    `over:${counts.overdueDeliveries}`,
    `up:${counts.upcomingDeliveries}`,
    `miss:${counts.criticalMissing}`,
  ].join("|");
}

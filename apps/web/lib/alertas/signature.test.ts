import { describe, expect, it } from "vitest";

import { alertSignature, type AlertCounts } from "./signature";

const ALL_CLEAR_COUNTS: AlertCounts = {
  expiredBatches: 0,
  criticalBatches: 0,
  overdueDeliveries: 0,
  upcomingDeliveries: 0,
  criticalMissing: 0,
};

describe("alertSignature", () => {
  it("returns the same signature for identical alert counts", () => {
    const counts: AlertCounts = {
      expiredBatches: 2,
      criticalBatches: 3,
      overdueDeliveries: 5,
      upcomingDeliveries: 7,
      criticalMissing: 11,
    };

    expect(alertSignature(counts)).toBe(alertSignature({ ...counts }));
  });

  it("changes when any count changes", () => {
    const baseline: AlertCounts = {
      expiredBatches: 1,
      criticalBatches: 1,
      overdueDeliveries: 1,
      upcomingDeliveries: 1,
      criticalMissing: 1,
    };

    const changed: AlertCounts = { ...baseline, expiredBatches: 2 };

    expect(alertSignature(changed)).not.toBe(alertSignature(baseline));
  });

  it("is independent from object property insertion order", () => {
    const canonical: AlertCounts = {
      expiredBatches: 4,
      criticalBatches: 8,
      overdueDeliveries: 15,
      upcomingDeliveries: 16,
      criticalMissing: 23,
    };
    const differentOrder = {
      criticalMissing: 23,
      upcomingDeliveries: 16,
      overdueDeliveries: 15,
      criticalBatches: 8,
      expiredBatches: 4,
    } satisfies AlertCounts;

    expect(alertSignature(differentOrder)).toBe(alertSignature(canonical));
  });

  it("returns a stable canonical signature for all-clear counts", () => {
    expect(alertSignature(ALL_CLEAR_COUNTS)).toBe(
      "exp:0|crit:0|over:0|up:0|miss:0",
    );
  });
});

import { describe, expect, it } from "vitest";

import { alertSignature, type AlertCounts } from "./signature";

const ALL_CLEAR_COUNTS: AlertCounts = {
  expiredBatches: 0,
  criticalBatches: 0,
  warningBatches: 0,
  overdueDeliveries: 0,
  upcomingDeliveries: 0,
  criticalMissing: 0,
  stockoutProducts: 0,
};

describe("alertSignature", () => {
  it("returns the same signature for identical alert counts", () => {
    const counts: AlertCounts = {
      expiredBatches: 2,
      criticalBatches: 3,
      warningBatches: 4,
      overdueDeliveries: 5,
      upcomingDeliveries: 7,
      criticalMissing: 11,
      stockoutProducts: 13,
    };

    expect(alertSignature(counts)).toBe(alertSignature({ ...counts }));
  });

  it("changes when any count changes", () => {
    const baseline: AlertCounts = {
      expiredBatches: 1,
      criticalBatches: 1,
      warningBatches: 1,
      overdueDeliveries: 1,
      upcomingDeliveries: 1,
      criticalMissing: 1,
      stockoutProducts: 1,
    };

    const changed: AlertCounts = { ...baseline, expiredBatches: 2 };

    expect(alertSignature(changed)).not.toBe(alertSignature(baseline));
  });

  it("is independent from object property insertion order", () => {
    const canonical: AlertCounts = {
      expiredBatches: 4,
      criticalBatches: 8,
      warningBatches: 9,
      overdueDeliveries: 15,
      upcomingDeliveries: 16,
      criticalMissing: 23,
      stockoutProducts: 42,
    };
    const differentOrder = {
      stockoutProducts: 42,
      criticalMissing: 23,
      upcomingDeliveries: 16,
      overdueDeliveries: 15,
      criticalBatches: 8,
      warningBatches: 9,
      expiredBatches: 4,
    } satisfies AlertCounts;

    expect(alertSignature(differentOrder)).toBe(alertSignature(canonical));
  });

  // Un quiebre nuevo tiene que cambiar la firma: si no, la barra pospuesta no
  // se vuelve a mostrar y bodega no se entera de que apareció.
  it("changes when a stockout appears", () => {
    const withStockout: AlertCounts = { ...ALL_CLEAR_COUNTS, stockoutProducts: 1 };

    expect(alertSignature(withStockout)).not.toBe(alertSignature(ALL_CLEAR_COUNTS));
  });

  it("returns a stable canonical signature for all-clear counts", () => {
    expect(alertSignature(ALL_CLEAR_COUNTS)).toBe(
      "exp:0|crit:0|warn:0|over:0|up:0|miss:0|stockout:0",
    );
  });
});

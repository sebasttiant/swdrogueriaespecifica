import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getExpiringBatchCounts: vi.fn(),
  countOverduePendings: vi.fn(),
  countUpcomingPendings: vi.fn(),
  countOverdueMissingItems: vi.fn(),
}));

vi.mock("@/server/services/product-batch.service", () => ({
  getExpiringBatchCounts: mocks.getExpiringBatchCounts,
}));
vi.mock("@/server/repositories/pending.repository", () => ({
  countOverduePendings: mocks.countOverduePendings,
  countUpcomingPendings: mocks.countUpcomingPendings,
}));
vi.mock("@/server/repositories/missing-item.repository", () => ({
  countOverdueMissingItems: mocks.countOverdueMissingItems,
}));

import { getOperationalAlerts } from "./operational-alerts.service";

const NOW = new Date("2026-07-30T22:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getExpiringBatchCounts.mockResolvedValue({ expired: 3, critical: 2 });
  mocks.countOverduePendings.mockResolvedValue(4);
  mocks.countUpcomingPendings.mockResolvedValue(5);
  mocks.countOverdueMissingItems.mockResolvedValue(6);
});

// --------------------------------------------------------------------------
// El aviso le habla al RESPONSABLE. Gerencia ve toda la droguería; el vendedor
// ve solo lo que él prometió; y quien no tiene pendientes a cargo no recibe
// nada. Antes esta barra le mostraba a bodega "Próximas 1" —entregas a
// clientes— en la única pantalla que esa persona usa.
// --------------------------------------------------------------------------
describe("getOperationalAlerts · a quién le habla cada aviso", () => {
  it("gerencia ve el estado completo de la droguería", async () => {
    await expect(getOperationalAlerts(NOW, { kind: "global" })).resolves.toEqual({
      expiredBatches: 3,
      criticalBatches: 2,
      overdueDeliveries: 4,
      upcomingDeliveries: 5,
      criticalMissing: 6,
    });
    expect(mocks.countOverduePendings).toHaveBeenCalledWith(NOW);
  });

  it("el vendedor solo ve las entregas que él prometió", async () => {
    mocks.countOverduePendings.mockResolvedValue(1);
    mocks.countUpcomingPendings.mockResolvedValue(2);

    await expect(
      getOperationalAlerts(NOW, { kind: "owner", ownerId: "seller-1" }),
    ).resolves.toEqual({
      expiredBatches: 0,
      criticalBatches: 0,
      overdueDeliveries: 1,
      upcomingDeliveries: 2,
      criticalMissing: 0,
    });

    expect(mocks.countOverduePendings).toHaveBeenCalledWith(NOW, "seller-1");
    expect(mocks.countUpcomingPendings).toHaveBeenCalledWith(NOW, "seller-1");
  });

  it("no le carga al vendedor lotes ni faltantes, que no resuelve él", async () => {
    await getOperationalAlerts(NOW, { kind: "owner", ownerId: "seller-1" });

    expect(mocks.getExpiringBatchCounts).not.toHaveBeenCalled();
    expect(mocks.countOverdueMissingItems).not.toHaveBeenCalled();
  });

  it("quien no tiene pendientes a cargo no recibe ningún aviso", async () => {
    await expect(getOperationalAlerts(NOW, { kind: "none" })).resolves.toEqual({
      expiredBatches: 0,
      criticalBatches: 0,
      overdueDeliveries: 0,
      upcomingDeliveries: 0,
      criticalMissing: 0,
    });

    expect(mocks.countOverduePendings).not.toHaveBeenCalled();
    expect(mocks.countUpcomingPendings).not.toHaveBeenCalled();
    expect(mocks.getExpiringBatchCounts).not.toHaveBeenCalled();
    expect(mocks.countOverdueMissingItems).not.toHaveBeenCalled();
  });
});

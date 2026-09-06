import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getExpiringBatchCounts: vi.fn(),
  countOverduePendings: vi.fn(),
  countUpcomingPendings: vi.fn(),
  countOverdueMissingItems: vi.fn(),
  countStockoutProducts: vi.fn(),
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
vi.mock("@/server/services/stockout.service", () => ({
  countStockoutProducts: mocks.countStockoutProducts,
}));

import { getOperationalAlerts } from "./operational-alerts.service";

const NOW = new Date("2026-07-30T22:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getExpiringBatchCounts.mockResolvedValue({ expired: 3, critical: 2, warning: 8 });
  mocks.countOverduePendings.mockResolvedValue(4);
  mocks.countUpcomingPendings.mockResolvedValue(5);
  mocks.countOverdueMissingItems.mockResolvedValue(6);
  mocks.countStockoutProducts.mockResolvedValue(7);
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
      // La franja de 90 días: se calculaba desde siempre y el servicio la
      // descartaba antes de llegar a la barra.
      warningBatches: 8,
      overdueDeliveries: 4,
      upcomingDeliveries: 5,
      criticalMissing: 6,
      stockoutProducts: 7,
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
      warningBatches: 0,
      warningBatches: 0,
      overdueDeliveries: 1,
      upcomingDeliveries: 2,
      criticalMissing: 0,
      stockoutProducts: 0,
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
      warningBatches: 0,
      overdueDeliveries: 0,
      upcomingDeliveries: 0,
      criticalMissing: 0,
      stockoutProducts: 0,
    });

    expect(mocks.countOverduePendings).not.toHaveBeenCalled();
    expect(mocks.countUpcomingPendings).not.toHaveBeenCalled();
    expect(mocks.getExpiringBatchCounts).not.toHaveBeenCalled();
    expect(mocks.countOverdueMissingItems).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// El alcance de BODEGA. Durante un tiempo no recibía NINGÚN aviso, y con razón:
// lo que había eran entregas a clientes y lotes por vencer, trabajo ajeno.
//
// Hay UN hecho que solo ella puede resolver: un producto que la droguería sí
// lleva se quedó sin con qué cubrir lo prometido. Antes de comprarlo hay que
// mirar el depósito, porque la caja puede estar recibida y sin cargar.
// --------------------------------------------------------------------------
describe("getOperationalAlerts · alcance de bodega", () => {
  it("le da el quiebre de stock y NADA más", async () => {
    const counts = await getOperationalAlerts(NOW, { kind: "warehouse" });

    expect(counts.stockoutProducts).toBe(7);
    // Entregas a clientes y lotes por vencer no son trabajo suyo: un aviso que
    // no puede resolver enseña a ignorar la barra entera.
    expect(counts.overdueDeliveries).toBe(0);
    expect(counts.upcomingDeliveries).toBe(0);
    expect(counts.expiredBatches).toBe(0);
    expect(counts.criticalBatches).toBe(0);
    expect(counts.warningBatches).toBe(0);
    expect(counts.criticalMissing).toBe(0);
  });

  it("no gasta ninguna consulta ajena para armarlo", async () => {
    await getOperationalAlerts(NOW, { kind: "warehouse" });

    expect(mocks.countStockoutProducts).toHaveBeenCalledTimes(1);
    expect(mocks.getExpiringBatchCounts).not.toHaveBeenCalled();
    expect(mocks.countOverduePendings).not.toHaveBeenCalled();
    expect(mocks.countOverdueMissingItems).not.toHaveBeenCalled();
  });

  // Gerencia también lo ve: un quiebre con clientes esperando es la señal más
  // temprana de que hay que comprar, antes de que el faltante venza.
  it("gerencia también lo recibe, junto con el resto", async () => {
    const counts = await getOperationalAlerts(NOW, { kind: "global" });

    expect(counts.stockoutProducts).toBe(7);
    expect(counts.criticalMissing).toBe(6);
  });

  // El vendedor no: él reporta y sigue vendiendo. Buscar una caja en el
  // depósito no es su trabajo.
  it("el vendedor no lo recibe", async () => {
    const counts = await getOperationalAlerts(NOW, { kind: "owner", ownerId: "u-1" });

    expect(counts.stockoutProducts).toBe(0);
    expect(mocks.countStockoutProducts).not.toHaveBeenCalled();
  });
});

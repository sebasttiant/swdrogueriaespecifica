// --------------------------------------------------------------------------
// TDD — closeMissingItemsByEntry
//
// MissingItem HAS a `quantity` field (Int, not null).
// OPEN statuses: FALTANTE, PEDIDO, EN_BODEGA (from OPEN_STATUSES in the repository).
// CLOSED/resolved status: RECIBIDO (the schema's "received/fulfilled" state).
// MissingItem has NO resolvedAt/closedAt timestamp field.
//
// Close rule (quantity-aware, FIFO):
//   - Fetch OPEN items for the product ordered by createdAt ASC.
//   - Iterate: automatic items use quantity; manual items use orderedQuantity.
//   - A manual item without orderedQuantity is not reconciled by its sentinel.
//   - STOP when the next item's quantity > remaining or no items remain.
//   - NO partial closing of an item.
//   - Returns array of closed item ids.
// --------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

// We need a tx mock that exposes missingItem.findMany and missingItem.updateMany.
// `as never` is the project-wide pattern for partial tx mocks (see
// product-batch-upsert.repository.test.ts) — the cast tells TS we only
// exercise the surface the function actually touches.
const { txMock } = vi.hoisted(() => {
  const txMock = {
    missingItem: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return { txMock };
});

// The repository imports prisma for non-tx calls; we mock it but don't use it here.
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    missingItem: {
      count: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import { closeMissingItemsByEntry } from "./missing-item.repository";

beforeEach(() => {
  vi.clearAllMocks();
  txMock.missingItem.updateMany.mockResolvedValue({ count: 1 });
});

describe("closeMissingItemsByEntry · FIFO quantity-aware close", () => {
  it("closes items in FIFO order (oldest first) when quantity is sufficient", async () => {
    // Two open items: oldest has qty=3, newest has qty=5. Available=8 covers both.
    txMock.missingItem.findMany.mockResolvedValue([
      { id: "m1", status: "FALTANTE", quantity: 3 },
      { id: "m2", status: "FALTANTE", quantity: 5 },
    ]);

    const result = await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_1",
      availableQuantity: 8,
    });

    expect(result).toEqual(["m1", "m2"]);
    expect(txMock.missingItem.updateMany).toHaveBeenCalledTimes(2);
    // First call closes m1, second closes m2
    expect(txMock.missingItem.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "m1", status: "FALTANTE", confirmedAt: null },
      data: { status: "RECIBIDO" },
    });
    expect(txMock.missingItem.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "m2", status: "FALTANTE", confirmedAt: null },
      data: { status: "RECIBIDO" },
    });
  });

  it("stops when the next open item quantity exceeds remaining available (no partial close)", async () => {
    // available=4: closes m1 (qty=3, remaining=1), then m2 (qty=5) exceeds remaining → STOP
    txMock.missingItem.findMany.mockResolvedValue([
      { id: "m1", status: "FALTANTE", quantity: 3 },
      { id: "m2", status: "FALTANTE", quantity: 5 },
    ]);

    const result = await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_1",
      availableQuantity: 4,
    });

    expect(result).toEqual(["m1"]);
    expect(txMock.missingItem.updateMany).toHaveBeenCalledTimes(1);
    expect(txMock.missingItem.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", status: "FALTANTE", confirmedAt: null },
      data: { status: "RECIBIDO" },
    });
  });

  it("returns empty array and makes no updates when there are no open items", async () => {
    txMock.missingItem.findMany.mockResolvedValue([]);

    const result = await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_1",
      availableQuantity: 100,
    });

    expect(result).toEqual([]);
    expect(txMock.missingItem.updateMany).not.toHaveBeenCalled();
  });

  it("closes nothing when available quantity is 0", async () => {
    txMock.missingItem.findMany.mockResolvedValue([
      { id: "m1", status: "FALTANTE", quantity: 1 },
    ]);

    const result = await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_1",
      availableQuantity: 0,
    });

    expect(result).toEqual([]);
    expect(txMock.missingItem.updateMany).not.toHaveBeenCalled();
  });

  it("sets the real closed status RECIBIDO (not FALTANTE, PEDIDO, or CANCELADO)", async () => {
    txMock.missingItem.findMany.mockResolvedValue([
      { id: "m1", status: "FALTANTE", quantity: 2 },
    ]);

    await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_1",
      availableQuantity: 5,
    });

    const updateArgs = txMock.missingItem.updateMany.mock.calls[0]![0];
    expect(updateArgs.data.status).toBe("RECIBIDO");
    expect(updateArgs.data.status).not.toBe("FALTANTE");
    expect(updateArgs.data.status).not.toBe("PEDIDO");
    expect(updateArgs.data.status).not.toBe("CANCELADO");
  });

  it("queries only OPEN, unconfirmed items for the given productId, ordered by createdAt ASC", async () => {
    txMock.missingItem.findMany.mockResolvedValue([]);

    await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_abc",
      availableQuantity: 10,
    });

    expect(txMock.missingItem.findMany).toHaveBeenCalledWith({
      where: {
        productId: "prod_abc",
        status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] },
        confirmedAt: null,
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        status: true,
        quantity: true,
        originId: true,
        orderedQuantity: true,
      },
    });
  });

  it("only affects the given productId, not items from other products", async () => {
    // Only returns items for the requested product (DB filtered by productId)
    txMock.missingItem.findMany.mockResolvedValue([
      { id: "m1", status: "FALTANTE", quantity: 2 }, // belongs to prod_1 (filtered by DB)
    ]);

    const result = await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_1",
      availableQuantity: 10,
    });

    // Confirm the where clause scopes to the product
    const queryArgs = txMock.missingItem.findMany.mock.calls[0]![0];
    expect(queryArgs.where.productId).toBe("prod_1");
    // And only the items returned (belonging to prod_1) were closed
    expect(result).toEqual(["m1"]);
  });

  it("closes exactly the items that fit within available quantity (exact boundary)", async () => {
    // available=5, item qty=5: should close exactly (remaining becomes 0)
    txMock.missingItem.findMany.mockResolvedValue([
      { id: "m1", status: "FALTANTE", quantity: 5 },
      { id: "m2", status: "FALTANTE", quantity: 1 },
    ]);

    const result = await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_1",
      availableQuantity: 5,
    });

    // m1 closes (remaining=0), m2 can't close (qty=1 > 0)
    expect(result).toEqual(["m1"]);
    expect(txMock.missingItem.updateMany).toHaveBeenCalledTimes(1);
  });

  it("skips an unordered manual item and continues with the next automatic deficit", async () => {
    txMock.missingItem.findMany.mockResolvedValue([
      { id: "manual", status: "FALTANTE", quantity: 1, originId: null, orderedQuantity: null },
      { id: "automatic", status: "FALTANTE", quantity: 1, originId: "pending-1", orderedQuantity: null },
    ]);

    const result = await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_1",
      availableQuantity: 1,
    });

    expect(result).toEqual(["automatic"]);
    expect(txMock.missingItem.updateMany).toHaveBeenCalledWith({
      where: { id: "automatic", status: "FALTANTE", confirmedAt: null },
      data: { status: "RECIBIDO" },
    });
  });

  it("uses orderedQuantity instead of the manual sentinel for reconciliation", async () => {
    txMock.missingItem.findMany.mockResolvedValue([
      { id: "manual", status: "FALTANTE", quantity: 1, originId: null, orderedQuantity: 5 },
    ]);

    await expect(
      closeMissingItemsByEntry(txMock as never, {
        productId: "prod_1",
        availableQuantity: 1,
      }),
    ).resolves.toEqual([]);
    expect(txMock.missingItem.updateMany).not.toHaveBeenCalled();
  });

  it("does not count a lost compare-and-set and uses the quantity on the next FIFO item", async () => {
    txMock.missingItem.findMany.mockResolvedValue([
      { id: "claimed", status: "EN_BODEGA", quantity: 5, originId: "pending-1" },
      { id: "next", status: "EN_BODEGA", quantity: 5, originId: "pending-2" },
    ]);
    txMock.missingItem.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(
      closeMissingItemsByEntry(txMock as never, {
        productId: "prod_1",
        availableQuantity: 5,
      }),
    ).resolves.toEqual(["next"]);

    expect(txMock.missingItem.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "claimed", status: "EN_BODEGA", confirmedAt: null },
      data: { status: "RECIBIDO" },
    });
    expect(txMock.missingItem.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "next", status: "EN_BODEGA", confirmedAt: null },
      data: { status: "RECIBIDO" },
    });
  });
});

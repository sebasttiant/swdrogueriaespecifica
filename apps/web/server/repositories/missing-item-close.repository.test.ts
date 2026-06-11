// --------------------------------------------------------------------------
// TDD — closeMissingItemsByEntry
//
// MissingItem HAS a `quantity` field (Int, not null).
// OPEN statuses: FALTANTE, PEDIDO (from OPEN_STATUSES in the repository).
// CLOSED/resolved status: RECIBIDO (the schema's "received/fulfilled" state).
// MissingItem has NO resolvedAt/closedAt timestamp field.
//
// Close rule (quantity-aware, FIFO):
//   - Fetch OPEN items for the product ordered by createdAt ASC.
//   - Iterate: if item.quantity <= remaining, set status=RECIBIDO and subtract.
//   - STOP when the next item's quantity > remaining or no items remain.
//   - NO partial closing of an item.
//   - Returns array of closed item ids.
// --------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

// We need a tx mock that exposes missingItem.findMany and missingItem.update.
// `as never` is the project-wide pattern for partial tx mocks (see
// product-batch-upsert.repository.test.ts) — the cast tells TS we only
// exercise the surface the function actually touches.
const { txMock } = vi.hoisted(() => {
  const txMock = {
    missingItem: {
      findMany: vi.fn(),
      update: vi.fn(),
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
  txMock.missingItem.update.mockResolvedValue({});
});

describe("closeMissingItemsByEntry · FIFO quantity-aware close", () => {
  it("closes items in FIFO order (oldest first) when quantity is sufficient", async () => {
    // Two open items: oldest has qty=3, newest has qty=5. Available=8 covers both.
    txMock.missingItem.findMany.mockResolvedValue([
      { id: "m1", quantity: 3 },
      { id: "m2", quantity: 5 },
    ]);

    const result = await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_1",
      availableQuantity: 8,
    });

    expect(result).toEqual(["m1", "m2"]);
    expect(txMock.missingItem.update).toHaveBeenCalledTimes(2);
    // First call closes m1, second closes m2
    expect(txMock.missingItem.update).toHaveBeenNthCalledWith(1, {
      where: { id: "m1" },
      data: { status: "RECIBIDO" },
    });
    expect(txMock.missingItem.update).toHaveBeenNthCalledWith(2, {
      where: { id: "m2" },
      data: { status: "RECIBIDO" },
    });
  });

  it("stops when the next open item quantity exceeds remaining available (no partial close)", async () => {
    // available=4: closes m1 (qty=3, remaining=1), then m2 (qty=5) exceeds remaining → STOP
    txMock.missingItem.findMany.mockResolvedValue([
      { id: "m1", quantity: 3 },
      { id: "m2", quantity: 5 },
    ]);

    const result = await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_1",
      availableQuantity: 4,
    });

    expect(result).toEqual(["m1"]);
    expect(txMock.missingItem.update).toHaveBeenCalledTimes(1);
    expect(txMock.missingItem.update).toHaveBeenCalledWith({
      where: { id: "m1" },
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
    expect(txMock.missingItem.update).not.toHaveBeenCalled();
  });

  it("closes nothing when available quantity is 0", async () => {
    txMock.missingItem.findMany.mockResolvedValue([
      { id: "m1", quantity: 1 },
    ]);

    const result = await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_1",
      availableQuantity: 0,
    });

    expect(result).toEqual([]);
    expect(txMock.missingItem.update).not.toHaveBeenCalled();
  });

  it("sets the real closed status RECIBIDO (not FALTANTE, PEDIDO, or CANCELADO)", async () => {
    txMock.missingItem.findMany.mockResolvedValue([
      { id: "m1", quantity: 2 },
    ]);

    await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_1",
      availableQuantity: 5,
    });

    const updateArgs = txMock.missingItem.update.mock.calls[0]![0];
    expect(updateArgs.data.status).toBe("RECIBIDO");
    expect(updateArgs.data.status).not.toBe("FALTANTE");
    expect(updateArgs.data.status).not.toBe("PEDIDO");
    expect(updateArgs.data.status).not.toBe("CANCELADO");
  });

  it("queries only OPEN statuses (FALTANTE, PEDIDO) for the given productId, ordered by createdAt ASC", async () => {
    txMock.missingItem.findMany.mockResolvedValue([]);

    await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_abc",
      availableQuantity: 10,
    });

    expect(txMock.missingItem.findMany).toHaveBeenCalledWith({
      where: {
        productId: "prod_abc",
        status: { in: ["FALTANTE", "PEDIDO"] },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, quantity: true },
    });
  });

  it("only affects the given productId, not items from other products", async () => {
    // Only returns items for the requested product (DB filtered by productId)
    txMock.missingItem.findMany.mockResolvedValue([
      { id: "m1", quantity: 2 }, // belongs to prod_1 (filtered by DB)
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
      { id: "m1", quantity: 5 },
      { id: "m2", quantity: 1 },
    ]);

    const result = await closeMissingItemsByEntry(txMock as never, {
      productId: "prod_1",
      availableQuantity: 5,
    });

    // m1 closes (remaining=0), m2 can't close (qty=1 > 0)
    expect(result).toEqual(["m1"]);
    expect(txMock.missingItem.update).toHaveBeenCalledTimes(1);
  });
});

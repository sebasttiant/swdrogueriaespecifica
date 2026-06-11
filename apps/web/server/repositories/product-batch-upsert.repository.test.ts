import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolated test for upsertBatchQuantity — uses a tx mock (TransactionClient).
// The function receives a tx client, so we test it by passing the tx mock directly
// rather than mocking the prisma singleton.
const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    productBatch: {
      count: vi.fn(),
      upsert: vi.fn(),
    },
  };
  return { prismaMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { upsertBatchQuantity } from "./product-batch.repository";

const txMock = {
  productBatch: {
    upsert: vi.fn(),
  },
};

const BASE_PARAMS = {
  productId: "prod_1",
  batchCode: "LOTE-001",
  expiresAt: new Date("2027-01-01T05:00:00.000Z"),
  quantity: 10,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("upsertBatchQuantity", () => {
  it("calls tx.productBatch.upsert with the correct where clause (productId + batchCode unique key)", async () => {
    txMock.productBatch.upsert.mockResolvedValue({ id: "batch_1" });

    await upsertBatchQuantity(txMock as never, BASE_PARAMS);

    expect(txMock.productBatch.upsert).toHaveBeenCalledTimes(1);
    const call = txMock.productBatch.upsert.mock.calls[0]![0];
    expect(call.where).toEqual({
      productId_batchCode: {
        productId: "prod_1",
        batchCode: "LOTE-001",
      },
    });
  });

  it("on CREATE: sets quantity, expiresAt, productId, batchCode, and status DISPONIBLE", async () => {
    txMock.productBatch.upsert.mockResolvedValue({ id: "batch_new" });

    await upsertBatchQuantity(txMock as never, BASE_PARAMS);

    const call = txMock.productBatch.upsert.mock.calls[0]![0];
    expect(call.create).toEqual(
      expect.objectContaining({
        productId: "prod_1",
        batchCode: "LOTE-001",
        expiresAt: BASE_PARAMS.expiresAt,
        quantity: 10,
        status: "DISPONIBLE",
      }),
    );
  });

  it("on UPDATE: increments quantity by the entered amount (not replace)", async () => {
    txMock.productBatch.upsert.mockResolvedValue({ id: "batch_existing" });

    await upsertBatchQuantity(txMock as never, { ...BASE_PARAMS, quantity: 5 });

    const call = txMock.productBatch.upsert.mock.calls[0]![0];
    // The update block must use { increment: 5 }, not set: 5
    expect(call.update.quantity).toEqual({ increment: 5 });
  });

  it("on UPDATE: does NOT change expiresAt (preserves existing batch expiry)", async () => {
    txMock.productBatch.upsert.mockResolvedValue({ id: "batch_existing" });

    await upsertBatchQuantity(txMock as never, BASE_PARAMS);

    const call = txMock.productBatch.upsert.mock.calls[0]![0];
    // expiresAt must NOT be in the update block
    expect(call.update.expiresAt).toBeUndefined();
  });

  it("returns the upserted ProductBatch row", async () => {
    const fakeBatch = { id: "batch_1", quantity: 10 };
    txMock.productBatch.upsert.mockResolvedValue(fakeBatch);

    const result = await upsertBatchQuantity(txMock as never, BASE_PARAMS);

    expect(result).toEqual(fakeBatch);
  });
});

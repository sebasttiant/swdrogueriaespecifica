import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Prisma — countExpiringBatches uses prisma.productBatch.count.
const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    productBatch: {
      count: vi.fn(),
    },
  };
  return { prismaMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { countExpiringBatches } from "./product-batch.repository";

// Fixed reference: 2026-06-09 12:00 UTC = 2026-06-09 07:00 Bogota.
const REF_NOW = new Date("2026-06-09T17:00:00.000Z"); // Bogota 12:00

beforeEach(() => {
  vi.clearAllMocks();
});

describe("countExpiringBatches", () => {
  it("returns counts from three parallel Prisma count calls", async () => {
    prismaMock.productBatch.count
      .mockResolvedValueOnce(3) // expired
      .mockResolvedValueOnce(2) // critical
      .mockResolvedValueOnce(1); // warning

    const result = await countExpiringBatches(REF_NOW);

    expect(result).toEqual({ expired: 3, critical: 2, warning: 1 });
    expect(prismaMock.productBatch.count).toHaveBeenCalledTimes(3);
  });

  it("expired count query: expiresAt < start-of-next-Bogota-day, quantity > 0", async () => {
    prismaMock.productBatch.count.mockResolvedValue(0);

    await countExpiringBatches(REF_NOW);

    const expiredCall = prismaMock.productBatch.count.mock.calls[0]![0];
    // expiresAt.lt should be > REF_NOW (start of the next calendar day in Bogota)
    expect(expiredCall.where.expiresAt.lt).toBeInstanceOf(Date);
    expect(expiredCall.where.expiresAt.lt.getTime()).toBeGreaterThan(
      REF_NOW.getTime(),
    );
    // No status filter (D3: all statuses included)
    expect(expiredCall.where.status).toBeUndefined();
    // quantity > 0
    expect(expiredCall.where.quantity).toEqual({ gt: 0 });
  });

  it("critical count query: expiresAt >= start-of-next-day AND < start-of-day+31, quantity > 0", async () => {
    prismaMock.productBatch.count.mockResolvedValue(0);

    await countExpiringBatches(REF_NOW);

    const criticalCall = prismaMock.productBatch.count.mock.calls[1]![0];
    expect(criticalCall.where.expiresAt.gte).toBeInstanceOf(Date);
    expect(criticalCall.where.expiresAt.lt).toBeInstanceOf(Date);
    // gte > REF_NOW (next Bogota calendar day boundary)
    expect(criticalCall.where.expiresAt.gte.getTime()).toBeGreaterThan(
      REF_NOW.getTime(),
    );
    // lt > gte (window is positive)
    expect(criticalCall.where.expiresAt.lt.getTime()).toBeGreaterThan(
      criticalCall.where.expiresAt.gte.getTime(),
    );
    expect(criticalCall.where.quantity).toEqual({ gt: 0 });
    expect(criticalCall.where.status).toBeUndefined();
  });

  it("warning count query: expiresAt >= start-of-day+31 AND < start-of-day+91, quantity > 0", async () => {
    prismaMock.productBatch.count.mockResolvedValue(0);

    await countExpiringBatches(REF_NOW);

    const warningCall = prismaMock.productBatch.count.mock.calls[2]![0];
    expect(warningCall.where.expiresAt.gte).toBeInstanceOf(Date);
    expect(warningCall.where.expiresAt.lt).toBeInstanceOf(Date);
    expect(warningCall.where.quantity).toEqual({ gt: 0 });
    expect(warningCall.where.status).toBeUndefined();
    // warning gte > critical gte
    const criticalCall = prismaMock.productBatch.count.mock.calls[1]![0];
    expect(warningCall.where.expiresAt.gte.getTime()).toBeGreaterThan(
      criticalCall.where.expiresAt.gte.getTime(),
    );
  });

  it("batch with quantity = 0 is excluded (quantity filter applies to all tiers)", async () => {
    prismaMock.productBatch.count.mockResolvedValue(0);

    await countExpiringBatches(REF_NOW);

    for (const call of prismaMock.productBatch.count.mock.calls) {
      expect(call[0].where.quantity).toEqual({ gt: 0 });
    }
  });

  it("no status filter — all BatchStatus values counted (D3: CUARENTENA and RETENIDO included)", async () => {
    prismaMock.productBatch.count.mockResolvedValue(5);

    await countExpiringBatches(REF_NOW);

    for (const call of prismaMock.productBatch.count.mock.calls) {
      expect(call[0].where.status).toBeUndefined();
    }
  });

  it("works without a ref argument (defaults to new Date())", async () => {
    prismaMock.productBatch.count.mockResolvedValue(0);

    await expect(countExpiringBatches()).resolves.toEqual({
      expired: 0,
      critical: 0,
      warning: 0,
    });
  });
});

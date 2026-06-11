import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Prisma singleton — we verify $transaction is called once.
const { prismaMock, tx } = vi.hoisted(() => {
  const tx = {
    productBatch: { upsert: vi.fn() },
    inventoryEntry: { create: vi.fn() },
  };
  const prismaMock = {
    $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  return { prismaMock, tx };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

// Mock the repositories so we assert their calls through the tx client
// rather than re-testing Prisma internals here.
vi.mock("@/server/repositories/product-batch.repository", () => ({
  upsertBatchQuantity: vi.fn(),
}));
vi.mock("@/server/repositories/inventory-entry.repository", () => ({
  createInventoryEntry: vi.fn(),
  listInventoryEntries: vi.fn(),
}));

import { upsertBatchQuantity } from "@/server/repositories/product-batch.repository";
import {
  createInventoryEntry,
  listInventoryEntries,
} from "@/server/repositories/inventory-entry.repository";
import {
  registerInventoryEntry,
  getInventoryEntries,
} from "./inventory-entry.service";

const BASE_INPUT = {
  productId: "prod_1",
  quantity: 10,
  batchCode: "LOTE-001",
  expiresAt: new Date("2027-01-01T05:00:00.000Z"),
  note: "Nota de prueba",
  createdById: "user_1",
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(
    (fn: (client: typeof tx) => unknown) => fn(tx),
  );
  vi.mocked(upsertBatchQuantity).mockResolvedValue({ id: "batch_1" } as never);
  vi.mocked(createInventoryEntry).mockResolvedValue({ id: "entry_1" } as never);
});

describe("registerInventoryEntry", () => {
  it("runs both writes inside a single $transaction call", async () => {
    await registerInventoryEntry(BASE_INPUT);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(upsertBatchQuantity).toHaveBeenCalledTimes(1);
    expect(createInventoryEntry).toHaveBeenCalledTimes(1);
  });

  it("passes the tx client to upsertBatchQuantity (not the prisma singleton)", async () => {
    await registerInventoryEntry(BASE_INPUT);

    const upsertCall = vi.mocked(upsertBatchQuantity).mock.calls[0]!;
    // First arg must be the tx object passed by $transaction callback
    expect(upsertCall[0]).toBe(tx);
  });

  it("passes the tx client to createInventoryEntry (not the prisma singleton)", async () => {
    await registerInventoryEntry(BASE_INPUT);

    const createCall = vi.mocked(createInventoryEntry).mock.calls[0]!;
    expect(createCall[0]).toBe(tx);
  });

  it("passes correct batchCode, expiresAt, quantity, productId to upsertBatchQuantity", async () => {
    await registerInventoryEntry(BASE_INPUT);

    expect(upsertBatchQuantity).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        productId: "prod_1",
        batchCode: "LOTE-001",
        expiresAt: BASE_INPUT.expiresAt,
        quantity: 10,
      }),
    );
  });

  it("passes correct productId, quantity, note, createdById to createInventoryEntry", async () => {
    await registerInventoryEntry(BASE_INPUT);

    expect(createInventoryEntry).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        productId: "prod_1",
        quantity: 10,
        note: "Nota de prueba",
        createdById: "user_1",
      }),
    );
  });

  it("if upsertBatchQuantity throws, the error propagates (full rollback)", async () => {
    vi.mocked(upsertBatchQuantity).mockRejectedValue(new Error("db down"));

    await expect(registerInventoryEntry(BASE_INPUT)).rejects.toThrow("db down");

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("returns an object with the created entry id", async () => {
    const result = await registerInventoryEntry(BASE_INPUT);

    expect(result.entry).toEqual({ id: "entry_1" });
  });

  it("does NOT call any missing-item closing logic (slice 2 is out of scope)", async () => {
    await registerInventoryEntry(BASE_INPUT);

    // No missingItem.update/updateMany calls should be made in slice 1
    expect(tx.inventoryEntry.create).not.toHaveBeenCalled(); // tx not used directly
    // Confirm only two repo calls happened
    expect(upsertBatchQuantity).toHaveBeenCalledTimes(1);
    expect(createInventoryEntry).toHaveBeenCalledTimes(1);
  });
});

describe("getInventoryEntries", () => {
  it("delegates to listInventoryEntries with cursor params", async () => {
    const fakePaginated = { items: [], nextCursor: null };
    vi.mocked(listInventoryEntries).mockResolvedValue(fakePaginated);

    const result = await getInventoryEntries({ cursor: "abc" });

    expect(listInventoryEntries).toHaveBeenCalledWith({ cursor: "abc" });
    expect(result).toEqual(fakePaginated);
  });
});

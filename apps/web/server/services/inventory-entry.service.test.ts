import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Prisma singleton — we verify $transaction is called once.
const { prismaMock, tx } = vi.hoisted(() => {
  const tx = {
    productBatch: { upsert: vi.fn(), update: vi.fn() },
    inventoryEntry: { create: vi.fn() },
    inventoryAllocation: { create: vi.fn() },
    missingItem: { update: vi.fn() },
    pending: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    $queryRaw: vi.fn(),
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
  reserveReceivedBatchQuantity: vi.fn(),
  reserveBatchForPending: vi.fn(),
  upsertBatchQuantity: vi.fn(),
}));
vi.mock("@/server/repositories/inventory-entry.repository", () => ({
  createInventoryEntry: vi.fn(),
  findInventoryEntryByIdempotencyKey: vi.fn(),
  listInventoryEntries: vi.fn(),
}));
vi.mock("@/server/repositories/missing-item.repository", () => ({
  closeMissingItemsByEntry: vi.fn(),
  listArrivedMissingItems: vi.fn(),
}));
vi.mock("@/server/repositories/missing-report.repository", () => ({
  markReportsReceivedByMissingItemIds: vi.fn(),
}));
vi.mock("@/server/services/notification-outbox.service", () => ({
  enqueuePendingAvailabilityNotification: vi.fn().mockResolvedValue({ id: "outbox-1" }),
}));

import {
  reserveReceivedBatchQuantity,
  upsertBatchQuantity,
} from "@/server/repositories/product-batch.repository";
import {
  createInventoryEntry,
  findInventoryEntryByIdempotencyKey,
  listInventoryEntries,
} from "@/server/repositories/inventory-entry.repository";
import { closeMissingItemsByEntry } from "@/server/repositories/missing-item.repository";
import { markReportsReceivedByMissingItemIds } from "@/server/repositories/missing-report.repository";
import {
  IdempotencyPayloadConflictError,
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
  vi.mocked(findInventoryEntryByIdempotencyKey).mockResolvedValue(null);
  vi.mocked(closeMissingItemsByEntry).mockResolvedValue(["m1", "m2"]);
  vi.mocked(markReportsReceivedByMissingItemIds).mockResolvedValue(2);
  tx.$queryRaw.mockResolvedValue([]);
  // enqueuePendingAvailabilityNotification reads the pending to find its owner.
  tx.pending.findUnique.mockResolvedValue({ id: "pending-1", createdById: "user_1" });
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

  it("returns an object with the created entry id and closedMissingCount", async () => {
    const result = await registerInventoryEntry(BASE_INPUT);

    expect(result.entry).toEqual({ id: "entry_1" });
    expect(result.closedMissingCount).toBe(2); // mock returns ["m1", "m2"]
  });

  it("calls closeMissingItemsByEntry inside the SAME $transaction (slice 2 wired)", async () => {
    await registerInventoryEntry(BASE_INPUT);

    // All three repo calls must happen inside the single $transaction callback
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(upsertBatchQuantity).toHaveBeenCalledTimes(1);
    expect(createInventoryEntry).toHaveBeenCalledTimes(1);
    expect(closeMissingItemsByEntry).toHaveBeenCalledTimes(1);
    expect(markReportsReceivedByMissingItemIds).toHaveBeenCalledWith(tx, ["m1", "m2"]);
  });

  it("passes the tx client to closeMissingItemsByEntry (not the prisma singleton)", async () => {
    await registerInventoryEntry(BASE_INPUT);

    const closeCall = vi.mocked(closeMissingItemsByEntry).mock.calls[0]!;
    expect(closeCall[0]).toBe(tx);
  });

  it("passes correct productId and quantity to closeMissingItemsByEntry", async () => {
    await registerInventoryEntry(BASE_INPUT);

    expect(closeMissingItemsByEntry).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        productId: "prod_1",
        availableQuantity: 10,
      }),
    );
  });

  it("returns closedMissingCount=0 when no items were closed", async () => {
    vi.mocked(closeMissingItemsByEntry).mockResolvedValue([]);

    const result = await registerInventoryEntry(BASE_INPUT);

    expect(result.closedMissingCount).toBe(0);
  });

  it("returns the existing entry for a retry with the same idempotency key", async () => {
    vi.mocked(findInventoryEntryByIdempotencyKey).mockResolvedValue({ id: "entry_existing" } as never);
    const result = await registerInventoryEntry({ ...BASE_INPUT, idempotencyKey: "key-1" });
    expect(result).toEqual(expect.objectContaining({ entry: { id: "entry_existing" }, idempotent: true }));
    expect(createInventoryEntry).not.toHaveBeenCalled();
  });

  it("rejects a reused idempotency key when the normalized note changes", async () => {
    await registerInventoryEntry({ ...BASE_INPUT, idempotencyKey: "key-note" });
    const requestFingerprint = vi.mocked(createInventoryEntry).mock.calls[0]![1].requestFingerprint;
    vi.mocked(findInventoryEntryByIdempotencyKey).mockResolvedValue({
      id: "entry_existing",
      requestFingerprint,
    } as never);

    await expect(registerInventoryEntry({
      ...BASE_INPUT,
      note: "Otra nota",
      idempotencyKey: "key-note",
    })).rejects.toBeInstanceOf(IdempotencyPayloadConflictError);
  });

  it("recovers the winning entry when concurrent inserts race on the unique key", async () => {
    vi.mocked(findInventoryEntryByIdempotencyKey)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "entry_winner" } as never);
    vi.mocked(createInventoryEntry).mockRejectedValue({ code: "P2002" });
    const result = await registerInventoryEntry({ ...BASE_INPUT, idempotencyKey: "key-race" });
    expect(result).toEqual(expect.objectContaining({ entry: { id: "entry_winner" }, idempotent: true }));
  });

  it("creates independent entries for distinct idempotency keys", async () => {
    await registerInventoryEntry({ ...BASE_INPUT, idempotencyKey: "key-a" });
    await registerInventoryEntry({ ...BASE_INPUT, idempotencyKey: "key-b" });
    expect(createInventoryEntry).toHaveBeenCalledTimes(2);
  });

  it("allocates a partial entry FIFO and advances the linked Pending availability", async () => {
    tx.$queryRaw.mockResolvedValue([{ id: "missing-1", quantity: 10, receivedQuantity: 0, originId: "pending-1" }]);
    tx.pending.findUniqueOrThrow.mockResolvedValue({ quantity: 10, inventoryReadyQuantity: 4, reservedInventoryQuantity: 4 });
    await registerInventoryEntry({ ...BASE_INPUT, quantity: 6, idempotencyKey: "fifo-6" });
    expect(tx.inventoryAllocation.create).toHaveBeenCalledWith({ data: { inventoryEntryId: "entry_1", missingItemId: "missing-1", pendingId: "pending-1", quantity: 6 } });
    expect(tx.pending.update).toHaveBeenCalledWith({ where: { id: "pending-1" }, data: { inventoryReadyQuantity: 10, reservedInventoryQuantity: 10, availabilityStatus: "DISPONIBLE_COMPLETO" } });
    expect(reserveReceivedBatchQuantity).toHaveBeenCalledWith(tx, "batch_1", 6);
  });

  it("marks reports received only after their MissingItem is fully received", async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([
        { id: "missing-partial", quantity: 10, orderedQuantity: null, receivedQuantity: 0, originId: "pending-1" },
      ])
      .mockResolvedValueOnce([
        { id: "missing-full", quantity: 4, orderedQuantity: null, receivedQuantity: 0, originId: "pending-2" },
      ]);
    tx.pending.findUniqueOrThrow
      .mockResolvedValueOnce({ quantity: 10, inventoryReadyQuantity: 0, reservedInventoryQuantity: 0 })
      .mockResolvedValueOnce({ quantity: 4, inventoryReadyQuantity: 0, reservedInventoryQuantity: 0 });

    await registerInventoryEntry({ ...BASE_INPUT, quantity: 6, idempotencyKey: "partial-report" });
    await registerInventoryEntry({ ...BASE_INPUT, quantity: 4, idempotencyKey: "full-report" });

    // Un parcial NO toca el status (D10): el ítem sigue siendo lo que era. Antes
    // pasaba a EN_BODEGA, que significa otra cosa —"recepción intentada, no
    // confirmada", lo que escribe `markMissingItemArrived`— y le daba dos
    // sentidos al mismo valor.
    expect(tx.missingItem.update).toHaveBeenNthCalledWith(1, {
      where: { id: "missing-partial" },
      data: { receivedQuantity: 6 },
    });
    expect(markReportsReceivedByMissingItemIds).toHaveBeenNthCalledWith(1, tx, []);
    expect(markReportsReceivedByMissingItemIds).toHaveBeenNthCalledWith(2, tx, ["missing-full"]);
  });

  it("keeps FIFO allocations reserved instead of leaving them globally sellable", async () => {
    tx.$queryRaw.mockResolvedValue([
      { id: "missing-1", quantity: 4, receivedQuantity: 0, originId: "pending-1" },
      { id: "missing-2", quantity: 6, receivedQuantity: 0, originId: "pending-2" },
    ]);
    tx.pending.findUniqueOrThrow
      .mockResolvedValueOnce({ quantity: 4, inventoryReadyQuantity: 0, reservedInventoryQuantity: 0 })
      .mockResolvedValueOnce({ quantity: 6, inventoryReadyQuantity: 0, reservedInventoryQuantity: 0 });

    await registerInventoryEntry({ ...BASE_INPUT, quantity: 10, idempotencyKey: "fifo-all" });

    expect(reserveReceivedBatchQuantity).toHaveBeenCalledWith(tx, "batch_1", 10);
    expect(tx.inventoryAllocation.create).toHaveBeenCalledTimes(2);
  });

  it("enqueues a notification when a pending becomes DISPONIBLE_COMPLETO", async () => {
    const { enqueuePendingAvailabilityNotification } = await import("@/server/services/notification-outbox.service");
    tx.$queryRaw.mockResolvedValue([{ id: "missing-1", quantity: 10, receivedQuantity: 0, originId: "pending-1" }]);
    tx.pending.findUniqueOrThrow.mockResolvedValue({ quantity: 10, inventoryReadyQuantity: 4, reservedInventoryQuantity: 4 });

    await registerInventoryEntry({ ...BASE_INPUT, quantity: 6, idempotencyKey: "notify-full" });

    expect(enqueuePendingAvailabilityNotification).toHaveBeenCalledWith(
      { pendingId: "pending-1", availabilityStatus: "DISPONIBLE_COMPLETO" },
      tx,
    );
  });

  it("enqueues DISPONIBLE_PARCIAL when the pending is not yet fully available", async () => {
    const { enqueuePendingAvailabilityNotification } = await import("@/server/services/notification-outbox.service");
    tx.$queryRaw.mockResolvedValue([{ id: "missing-1", quantity: 10, receivedQuantity: 0, originId: "pending-1" }]);
    tx.pending.findUniqueOrThrow.mockResolvedValue({ quantity: 10, inventoryReadyQuantity: 0, reservedInventoryQuantity: 0 });

    await registerInventoryEntry({ ...BASE_INPUT, quantity: 3, idempotencyKey: "notify-partial" });

    expect(enqueuePendingAvailabilityNotification).toHaveBeenCalledWith(
      { pendingId: "pending-1", availabilityStatus: "DISPONIBLE_PARCIAL" },
      tx,
    );
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

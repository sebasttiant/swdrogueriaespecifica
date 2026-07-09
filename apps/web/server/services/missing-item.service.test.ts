import { beforeEach, describe, expect, it, vi } from "vitest";

const { repo } = vi.hoisted(() => ({
  repo: {
    confirmMissingItem: vi.fn(),
    countOpenMissingItems: vi.fn(),
    countOverdueMissingItems: vi.fn(),
    findMissingItemById: vi.fn(),
    listMissingItems: vi.fn(),
  },
}));

vi.mock("@/server/repositories/missing-item.repository", () => repo);

import {
  confirmMissingItemOk,
  getMissingItems,
  getMissingItemsSummary,
} from "./missing-item.service";
import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

beforeEach(() => vi.clearAllMocks());

// Typed fixture for `listMissingItems` rows — mirrors `MissingItemListItem`
// exactly so tests catch accidental field drops/renames, not just missing PII.
function missingItemRow(
  overrides: Partial<MissingItemListItem> = {},
): MissingItemListItem {
  return {
    id: "missing-1",
    quantity: 3,
    status: "FALTANTE",
    originId: "pending-1",
    confirmedAt: null,
    confirmedById: null,
    confirmationNote: null,
    createdAt: new Date("2026-07-01T10:00:00.000Z"),
    product: { id: "prod-1", name: "Paracetamol", code: "P-001", unit: "unidad" },
    origin: {
      id: "pending-1",
      promisedAt: new Date("2026-07-03T10:00:00.000Z"),
      status: "PENDIENTE",
      customerName: "Juan Pérez",
    },
    ...overrides,
  };
}

// Deferred promise: lets a test control exactly when a mocked async call
// resolves, so concurrency can be asserted without timing hacks.
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function missing(overrides = {}) {
  return {
    id: "missing-1",
    status: "FALTANTE",
    confirmedAt: null,
    confirmedById: null,
    confirmationNote: null,
    ...overrides,
  };
}

describe("confirmMissingItemOk", () => {
  it("confirms an active missing item with the management user id", async () => {
    const confirmedAt = new Date("2026-07-02T20:00:00.000Z");
    repo.findMissingItemById.mockResolvedValue(missing());
    repo.confirmMissingItem.mockResolvedValue(
      missing({ confirmedAt, confirmedById: "admin-1" }),
    );

    const result = await confirmMissingItemOk({
      id: "missing-1",
      confirmedById: "admin-1",
      confirmedAt,
    });

    expect(result.changed).toBe(true);
    expect(repo.confirmMissingItem).toHaveBeenCalledWith({
      id: "missing-1",
      confirmedById: "admin-1",
      confirmedAt,
      note: undefined,
    });
  });

  it("is safe for already-confirmed and closed inventory statuses", async () => {
    const existingConfirmedAt = new Date("2026-07-01T10:00:00.000Z");
    repo.findMissingItemById.mockResolvedValueOnce(
      missing({ confirmedAt: existingConfirmedAt, confirmedById: "older" }),
    );
    await expect(
      confirmMissingItemOk({ id: "missing-1", confirmedById: "admin-1" }),
    ).resolves.toEqual({
      item: expect.objectContaining({ confirmedAt: existingConfirmedAt }),
      changed: false,
    });

    repo.findMissingItemById.mockResolvedValueOnce(missing({ status: "RECIBIDO" }));
    await expect(
      confirmMissingItemOk({ id: "missing-1", confirmedById: "admin-1" }),
    ).resolves.toEqual({
      item: expect.objectContaining({ status: "RECIBIDO" }),
      changed: false,
    });
    expect(repo.confirmMissingItem).toHaveBeenCalledTimes(0);
  });
});

describe("getMissingItems", () => {
  it("forwards cursor/take to listMissingItems and passes nextCursor through unchanged", async () => {
    const row = missingItemRow();
    repo.listMissingItems.mockResolvedValue({ items: [row], nextCursor: "cursor-abc" });

    const result = await getMissingItems({
      cursor: "cursor-in",
      take: 20,
      canViewCustomerIdentity: true,
    });

    expect(repo.listMissingItems).toHaveBeenCalledWith({
      cursor: "cursor-in",
      take: 20,
    });
    expect(result.nextCursor).toBe("cursor-abc");
  });

  it("nulls origin.customerName for every item when canViewCustomerIdentity is false, keeping every other field intact", async () => {
    const row = missingItemRow();
    repo.listMissingItems.mockResolvedValue({ items: [row], nextCursor: null });

    const result = await getMissingItems({ canViewCustomerIdentity: false });

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.origin?.customerName).toBeNull();
    expect(item).toEqual({
      ...row,
      origin: { ...row.origin, customerName: null },
    });
  });

  it("returns origin.customerName verbatim when canViewCustomerIdentity is true", async () => {
    const row = missingItemRow();
    repo.listMissingItems.mockResolvedValue({ items: [row], nextCursor: null });

    const result = await getMissingItems({ canViewCustomerIdentity: true });

    expect(result.items[0]!.origin?.customerName).toBe("Juan Pérez");
    expect(result.items[0]).toEqual(row);
  });

  it("passes items with origin === null through unchanged under both flags", async () => {
    const row = missingItemRow({ originId: null, origin: null });
    repo.listMissingItems.mockResolvedValue({ items: [row], nextCursor: null });

    const resultDenied = await getMissingItems({ canViewCustomerIdentity: false });
    expect(resultDenied.items[0]).toEqual(row);

    const resultAllowed = await getMissingItems({ canViewCustomerIdentity: true });
    expect(resultAllowed.items[0]).toEqual(row);
  });

  it("does not mutate the repository row in place when minimizing", async () => {
    const row = missingItemRow();
    repo.listMissingItems.mockResolvedValue({ items: [row], nextCursor: null });

    await getMissingItems({ canViewCustomerIdentity: false });

    // The object handed back by the mocked repo must still hold the
    // original customerName — the service must return NEW objects.
    expect(row.origin?.customerName).toBe("Juan Pérez");
  });
});

describe("getMissingItemsSummary", () => {
  const now = new Date("2026-07-09T10:00:00.000Z");

  it("returns { open, overdue } built from the two repository counts", async () => {
    repo.countOpenMissingItems.mockResolvedValue(7);
    repo.countOverdueMissingItems.mockResolvedValue(2);

    await expect(getMissingItemsSummary(now)).resolves.toEqual({
      open: 7,
      overdue: 2,
    });
  });

  it("propagates the injected `now` verbatim to countOverdueMissingItems", async () => {
    repo.countOpenMissingItems.mockResolvedValue(0);
    repo.countOverdueMissingItems.mockResolvedValue(0);

    await getMissingItemsSummary(now);

    // Exact reference/value check: a stray `new Date()` inside the service
    // would not equal the injected `now` and must fail this assertion.
    expect(repo.countOverdueMissingItems).toHaveBeenCalledWith(now);
    expect(repo.countOverdueMissingItems).toHaveBeenCalledTimes(1);
  });

  it("calls countOpenMissingItems with no arguments (no now-dependency)", async () => {
    repo.countOpenMissingItems.mockResolvedValue(0);
    repo.countOverdueMissingItems.mockResolvedValue(0);

    await getMissingItemsSummary(now);

    expect(repo.countOpenMissingItems).toHaveBeenCalledWith();
    expect(repo.countOpenMissingItems).toHaveBeenCalledTimes(1);
  });

  it("runs both counts concurrently, matching Promise.all semantics", async () => {
    const openDeferred = createDeferred<number>();
    const overdueDeferred = createDeferred<number>();
    repo.countOpenMissingItems.mockReturnValue(openDeferred.promise);
    repo.countOverdueMissingItems.mockReturnValue(overdueDeferred.promise);

    const resultPromise = getMissingItemsSummary(now);

    // Both repository calls must already have happened before either
    // promise resolves — a sequential `await a(); await b();` would only
    // have invoked the first one at this point.
    expect(repo.countOpenMissingItems).toHaveBeenCalledTimes(1);
    expect(repo.countOverdueMissingItems).toHaveBeenCalledTimes(1);

    openDeferred.resolve(4);
    overdueDeferred.resolve(1);

    await expect(resultPromise).resolves.toEqual({ open: 4, overdue: 1 });
  });

  it("returns zeros without throwing when there are no missing items", async () => {
    repo.countOpenMissingItems.mockResolvedValue(0);
    repo.countOverdueMissingItems.mockResolvedValue(0);

    await expect(getMissingItemsSummary(now)).resolves.toEqual({
      open: 0,
      overdue: 0,
    });
  });

  it("returns overdue === open faithfully when every open item is overdue", async () => {
    repo.countOpenMissingItems.mockResolvedValue(5);
    repo.countOverdueMissingItems.mockResolvedValue(5);

    await expect(getMissingItemsSummary(now)).resolves.toEqual({
      open: 5,
      overdue: 5,
    });
  });
});

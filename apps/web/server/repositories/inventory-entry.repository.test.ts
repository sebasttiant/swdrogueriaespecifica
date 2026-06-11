import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    inventoryEntry: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  };
  return { prismaMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import {
  createInventoryEntry,
  listInventoryEntries,
} from "./inventory-entry.repository";

const txMock = {
  inventoryEntry: {
    create: vi.fn(),
  },
};

const BASE_ENTRY_DATA = {
  productId: "prod_1",
  quantity: 10,
  note: "Recepción proveedor",
  createdById: "user_1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// createInventoryEntry
// ---------------------------------------------------------------------------

describe("createInventoryEntry", () => {
  it("calls tx.inventoryEntry.create with all required fields", async () => {
    txMock.inventoryEntry.create.mockResolvedValue({ id: "entry_1" });

    await createInventoryEntry(txMock as never, BASE_ENTRY_DATA);

    expect(txMock.inventoryEntry.create).toHaveBeenCalledTimes(1);
    const call = txMock.inventoryEntry.create.mock.calls[0]![0];
    expect(call.data).toEqual(
      expect.objectContaining({
        productId: "prod_1",
        quantity: 10,
        createdById: "user_1",
      }),
    );
  });

  it("persists note when provided", async () => {
    txMock.inventoryEntry.create.mockResolvedValue({ id: "entry_2" });

    await createInventoryEntry(txMock as never, BASE_ENTRY_DATA);

    const call = txMock.inventoryEntry.create.mock.calls[0]![0];
    expect(call.data.note).toBe("Recepción proveedor");
  });

  it("persists null note when not provided", async () => {
    txMock.inventoryEntry.create.mockResolvedValue({ id: "entry_3" });

    await createInventoryEntry(txMock as never, {
      ...BASE_ENTRY_DATA,
      note: undefined,
    });

    const call = txMock.inventoryEntry.create.mock.calls[0]![0];
    expect(call.data.note).toBeNull();
  });

  it("returns the created entry", async () => {
    const fakeEntry = { id: "entry_4", productId: "prod_1", quantity: 10 };
    txMock.inventoryEntry.create.mockResolvedValue(fakeEntry);

    const result = await createInventoryEntry(txMock as never, BASE_ENTRY_DATA);

    expect(result).toEqual(fakeEntry);
  });
});

// ---------------------------------------------------------------------------
// listInventoryEntries — cursor-based pagination
// ---------------------------------------------------------------------------

describe("listInventoryEntries", () => {
  it("returns items and null nextCursor when there are fewer rows than take", async () => {
    const rows = [{ id: "e1" }, { id: "e2" }];
    prismaMock.inventoryEntry.findMany.mockResolvedValue(rows);

    const result = await listInventoryEntries({ take: 20 });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it("returns items sliced to take and a non-null nextCursor when there are more rows", async () => {
    // take=2, so we ask for 3 rows; if 3 come back → hasMore
    const rows = [{ id: "e1" }, { id: "e2" }, { id: "e3" }];
    prismaMock.inventoryEntry.findMany.mockResolvedValue(rows);

    const result = await listInventoryEntries({ take: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
  });

  it("passes cursor to findMany when provided", async () => {
    prismaMock.inventoryEntry.findMany.mockResolvedValue([]);

    // encodeCursor("e1") for a round-trip cursor
    const { encodeCursor } = await import("@/lib/pagination");
    const cursor = encodeCursor("e1");

    await listInventoryEntries({ cursor });

    const call = prismaMock.inventoryEntry.findMany.mock.calls[0]![0];
    expect(call.cursor).toEqual({ id: "e1" });
    expect(call.skip).toBe(1);
  });

  it("orders by createdAt desc and id desc (newest first)", async () => {
    prismaMock.inventoryEntry.findMany.mockResolvedValue([]);

    await listInventoryEntries({});

    const call = prismaMock.inventoryEntry.findMany.mock.calls[0]![0];
    expect(call.orderBy).toEqual(
      expect.arrayContaining([
        { createdAt: "desc" },
        { id: "desc" },
      ]),
    );
  });

  it("selects product name/code and createdBy name", async () => {
    prismaMock.inventoryEntry.findMany.mockResolvedValue([]);

    await listInventoryEntries({});

    const call = prismaMock.inventoryEntry.findMany.mock.calls[0]![0];
    expect(call.select.product.select).toEqual(
      expect.objectContaining({ name: true, code: true }),
    );
    expect(call.select.createdBy.select).toEqual(
      expect.objectContaining({ name: true }),
    );
  });
});

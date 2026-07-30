import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, tx } = vi.hoisted(() => {
  const tx = {
    productBatch: { upsert: vi.fn() },
    inventoryEntry: { create: vi.fn() },
    missingItem: { findMany: vi.fn(), updateMany: vi.fn() },
    missingReport: { updateMany: vi.fn() },
  };
  const prismaMock = {
    $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  return { prismaMock, tx };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { registerInventoryEntry } from "./inventory-entry.service";

type MissingItemState = {
  id: string;
  productId: string;
  status: string;
  confirmedAt: null;
  quantity: number;
  originId: string;
  orderedQuantity: null;
};

type MissingReportState = {
  id: string;
  linkedMissingItemId: string;
  status: string;
};

let missingItems: MissingItemState[];
let missingReports: MissingReportState[];

beforeEach(() => {
  vi.clearAllMocks();
  missingItems = [
    {
      id: "missing-bodega",
      productId: "product-1",
      status: "EN_BODEGA",
      confirmedAt: null,
      quantity: 5,
      originId: "pending-1",
      orderedQuantity: null,
    },
  ];
  missingReports = [
    { id: "report-1", linkedMissingItemId: "missing-bodega", status: "EN_BODEGA" },
    { id: "report-2", linkedMissingItemId: "missing-bodega", status: "EN_BODEGA" },
  ];

  prismaMock.$transaction.mockImplementation(
    (fn: (client: typeof tx) => unknown) => fn(tx),
  );
  tx.productBatch.upsert.mockResolvedValue({ id: "batch-1" });
  tx.inventoryEntry.create.mockResolvedValue({ id: "entry-1" });
  tx.missingItem.findMany.mockImplementation(
    async (args: {
      where: {
        productId: string;
        status: { in: string[] };
        confirmedAt: null;
      };
    }) =>
      missingItems.filter(
        (item) =>
          item.productId === args.where.productId &&
          args.where.status.in.includes(item.status) &&
          item.confirmedAt === args.where.confirmedAt,
      ),
  );
  tx.missingItem.updateMany.mockImplementation(
    async (args: {
      where: { id: string; status: string; confirmedAt: null };
      data: { status: string };
    }) => {
      const item = missingItems.find(
        (candidate) =>
          candidate.id === args.where.id &&
          candidate.status === args.where.status &&
          candidate.confirmedAt === args.where.confirmedAt,
      );
      if (!item) return { count: 0 };
      item.status = args.data.status;
      return { count: 1 };
    },
  );
  tx.missingReport.updateMany.mockImplementation(
    async (args: {
      where: { linkedMissingItemId: { in: string[] }; status: string };
      data: { status: string };
    }) => {
      const updated = missingReports.filter(
        (report) =>
          args.where.linkedMissingItemId.in.includes(report.linkedMissingItemId) &&
          report.status === args.where.status,
      );
      for (const report of updated) report.status = args.data.status;
      return { count: updated.length };
    },
  );
});

describe("registerInventoryEntry · EN_BODEGA missing report reconciliation", () => {
  it("closes the arrived item and linked reports once within the transaction", async () => {
    const input = {
      productId: "product-1",
      quantity: 5,
      batchCode: "BATCH-1",
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    };

    await expect(registerInventoryEntry(input)).resolves.toMatchObject({
      entry: { id: "entry-1" },
      closedMissingCount: 1,
    });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(missingItems[0]?.status).toBe("RECIBIDO");
    expect(missingReports.map((report) => report.status)).toEqual([
      "RECEIVED",
      "RECEIVED",
    ]);
    expect(tx.missingItem.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.missingReport.updateMany).toHaveBeenCalledWith({
      where: {
        linkedMissingItemId: { in: ["missing-bodega"] },
        status: "EN_BODEGA",
      },
      data: { status: "RECEIVED" },
    });

    await expect(registerInventoryEntry(input)).resolves.toMatchObject({
      closedMissingCount: 0,
    });

    expect(tx.missingItem.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.missingReport.updateMany).toHaveBeenCalledTimes(1);
  });
});

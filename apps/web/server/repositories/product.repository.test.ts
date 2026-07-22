import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    product: {
      findMany: vi.fn(),
    },
  };
  return { prismaMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { encodeCursor } from "@/lib/pagination";
import { listProducts } from "./product.repository";

// Minimal valid ProductListItem row returned by the mock (batches are raw from Prisma).
function makeRow(overrides: Partial<{ id: string; name: string; code: string }> = {}) {
  return {
    id: overrides.id ?? "prod-1",
    code: overrides.code ?? "COD001",
    name: overrides.name ?? "Acetaminofen 500mg",
    unit: "caja",
    minStock: 10,
    reorderQty: 50,
    active: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    batches: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.product.findMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// q filter — name contains (case-insensitive)
// ---------------------------------------------------------------------------

describe("listProducts · q filter", () => {
  it("passes OR where clause when q matches by name (case-insensitive)", async () => {
    prismaMock.product.findMany.mockResolvedValueOnce([makeRow()]);

    await listProducts({ q: "aceta" });

    const args = prismaMock.product.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({
      OR: [
        { name: { contains: "aceta", mode: "insensitive" } },
        { code: { contains: "aceta", mode: "insensitive" } },
      ],
    });
  });

  it("passes OR where clause when q matches by code (case-insensitive)", async () => {
    prismaMock.product.findMany.mockResolvedValueOnce([makeRow()]);

    await listProducts({ q: "COD001" });

    const args = prismaMock.product.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({
      OR: [
        { name: { contains: "COD001", mode: "insensitive" } },
        { code: { contains: "COD001", mode: "insensitive" } },
      ],
    });
  });

  it("does NOT add where clause when q is empty string", async () => {
    await listProducts({ q: "" });

    const args = prismaMock.product.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });

  it("does NOT add where clause when q is whitespace-only", async () => {
    await listProducts({ q: "   " });

    const args = prismaMock.product.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });

  it("does NOT add where clause when q is undefined", async () => {
    await listProducts({});

    const args = prismaMock.product.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // cursor pagination preserved when q is active
  // ---------------------------------------------------------------------------

  it("cursor pagination still works alongside q filter", async () => {
    const cursorId = "prod-abc";
    prismaMock.product.findMany.mockResolvedValueOnce([makeRow({ id: "prod-abc" })]);

    await listProducts({ cursor: encodeCursor(cursorId), q: "aceta" });

    const args = prismaMock.product.findMany.mock.calls[0]![0];
    // cursor + skip must be present
    expect(args.cursor).toEqual({ id: cursorId });
    expect(args.skip).toBe(1);
    // filter must still be applied
    expect(args.where).toEqual({
      OR: [
        { name: { contains: "aceta", mode: "insensitive" } },
        { code: { contains: "aceta", mode: "insensitive" } },
      ],
    });
  });

  // ---------------------------------------------------------------------------
  // hasMore / nextCursor logic is not broken by q
  // ---------------------------------------------------------------------------

  it("returns nextCursor when more items exist with q active", async () => {
    // Return take+1 rows to signal hasMore
    const rows = Array.from({ length: 21 }, (_, i) =>
      makeRow({ id: `prod-${i}`, name: `Producto ${i}` }),
    );
    prismaMock.product.findMany.mockResolvedValueOnce(rows);

    const result = await listProducts({ q: "Producto", take: 20 });

    expect(result.items).toHaveLength(20);
    expect(result.nextCursor).not.toBeNull();
  });

  it("returns null nextCursor when no more items with q active", async () => {
    prismaMock.product.findMany.mockResolvedValueOnce([makeRow()]);

    const result = await listProducts({ q: "aceta", take: 20 });

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });
});

describe("listProducts · active filter", () => {
  it("filters active products in the paginated query before returning a page", async () => {
    prismaMock.product.findMany.mockResolvedValueOnce([makeRow()]);

    await listProducts({ active: true });

    const args = prismaMock.product.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({ active: true });
  });

  it("combines the active filter with catalog search", async () => {
    prismaMock.product.findMany.mockResolvedValueOnce([makeRow()]);

    await listProducts({ active: true, q: "aceta" });

    const args = prismaMock.product.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({
      active: true,
      OR: [
        { name: { contains: "aceta", mode: "insensitive" } },
        { code: { contains: "aceta", mode: "insensitive" } },
      ],
    });
  });
});

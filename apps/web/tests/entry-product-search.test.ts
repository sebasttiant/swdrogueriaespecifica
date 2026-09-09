import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/db/prisma", () => ({
  prisma: { product: { findFirst: vi.fn(), findMany: vi.fn() } },
}));
vi.mock("@/lib/auth/require-role", () => ({ requireCapability: vi.fn() }));
import { prisma } from "@/lib/db/prisma";
import { requireCapability } from "@/lib/auth/require-role";
import { getEntryProduct } from "@/server/services/product.service";
import { searchEntryProductsAction } from "@/server/actions/product-search.actions";
beforeEach(() => vi.clearAllMocks());
it.each(["inactive", "not-found"])(
  "excludes %s from exact resolution",
  async (id) => {
    vi.mocked(prisma.product.findFirst).mockResolvedValue(null);
    expect(await getEntryProduct(id)).toBeNull();
    expect(prisma.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id, active: true } }),
    );
  },
);
it("filters active products before bounded server paging", async () => {
  vi.mocked(prisma.product.findMany).mockResolvedValue([]);
  expect(await searchEntryProductsAction("Vichy")).toEqual([]);
  expect(requireCapability).toHaveBeenCalledWith("canCreateEntries");
  expect(prisma.product.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      take: 21,
      where: expect.objectContaining({ active: true, OR: expect.any(Array) }),
    }),
  );
});
it("propagates catalogue errors instead of returning an empty success", async () => {
  vi.mocked(prisma.product.findMany).mockRejectedValueOnce(
    new Error("catalogue unavailable"),
  );
  await expect(searchEntryProductsAction("Vichy")).rejects.toThrow(
    "catalogue unavailable",
  );
});

it("does not query for blank search or without permission", async () => {
  expect(await searchEntryProductsAction(" ")).toEqual([]);
  expect(prisma.product.findMany).not.toHaveBeenCalled();
  vi.mocked(requireCapability).mockRejectedValueOnce(new Error("denied"));
  await expect(searchEntryProductsAction("Vichy")).rejects.toThrow("denied");
  expect(prisma.product.findMany).not.toHaveBeenCalled();
});

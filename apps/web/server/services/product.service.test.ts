import { beforeEach, describe, expect, it, vi } from "vitest";

const { productRepo } = vi.hoisted(() => ({
  productRepo: {
    createProduct: vi.fn(),
    findProductById: vi.fn(),
    listProducts: vi.fn(),
  },
}));

vi.mock("@/server/repositories/product.repository", () => productRepo);

import { getActiveProductsForMissingItem } from "./product.service";

function product(id: string, active = true) {
  return {
    id,
    code: `CODE-${id}`,
    name: `Product ${id}`,
    unit: "unit",
    minStock: 0,
    reorderQty: 1,
    active,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    worstExpiresAt: null,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("getActiveProductsForMissingItem", () => {
	it("returns one bounded initial search page instead of traversing the catalog", async () => {
		productRepo.listProducts.mockResolvedValue({
			items: Array.from({ length: 20 }, (_, index) => product(`first-${index}`)),
			nextCursor: "page-2",
		});

		const result = await getActiveProductsForMissingItem({ q: "amoxi" });

		expect(result.items).toHaveLength(20);
		expect(result.nextCursor).toBe("page-2");
		expect(productRepo.listProducts).toHaveBeenCalledTimes(1);
		expect(productRepo.listProducts).toHaveBeenCalledWith({
			active: true,
			q: "amoxi",
			take: 20,
		});
	});

	it("reaches a product beyond the first 100 through its requested cursor while excluding inactive rows", async () => {
		productRepo.listProducts.mockResolvedValue({
			items: [product("inactive", false), product("beyond-100")],
			nextCursor: null,
		});

		await expect(
			getActiveProductsForMissingItem({ q: "beyond", cursor: "page-after-100" }),
		).resolves.toEqual({
			items: [
				{
					id: "beyond-100",
					name: "Product beyond-100",
					code: "CODE-beyond-100",
				},
			],
			nextCursor: null,
		});
		expect(productRepo.listProducts).toHaveBeenCalledWith({
			active: true,
			q: "beyond",
			cursor: "page-after-100",
			take: 20,
		});
	});
});

import { beforeEach, expect, it, vi } from "vitest";
import type { SessionRole } from "@/lib/auth/session";
const auth = vi.hoisted(() => ({ role: "ADMIN" as SessionRole }));
vi.mock("@/lib/auth/require-role", () => ({
  requireCapability: vi.fn(async () => ({ user: { role: auth.role } })),
}));
vi.mock("@/server/services/product.service", () => ({
  getProducts: vi.fn(async () => ({
    items: Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      active: true,
    })),
    nextCursor: "100",
  })),
  getEntryProduct: vi.fn(),
}));
vi.mock("@/server/services/inventory-entry.service", () => ({
  getInventoryEntries: vi.fn(async () => ({ items: [], nextCursor: null })),
  getArrivedMissingItems: vi.fn(async () => []),
}));
vi.mock("@/features/entradas/entry-form", () => ({ EntryForm: () => null }));
vi.mock("@/features/entradas/entry-list", () => ({ EntryList: () => null }));
vi.mock("@/features/entradas/arrived-missing-queue", () => ({
  ArrivedMissingQueue: () => null,
}));
import Page from "@/app/(dashboard)/entradas/page";
import {
  getEntryProduct,
  getProducts,
} from "@/server/services/product.service";
import { EntryForm } from "@/features/entradas/entry-form";
import { isValidElement, type ReactNode } from "react";
function formProps(node: ReactNode): Record<string, unknown> | undefined {
  if (Array.isArray(node)) return node.map(formProps).find(Boolean);
  if (!isValidElement<{ children?: ReactNode }>(node)) return;
  if (node.type === EntryForm) return { ...node.props, key: node.key };
  return formProps(node.props.children);
}
const target = {
  id: "183",
  name: "Vichy",
  code: "internal",
  orionCode: "OR-183",
  laboratoryName: "Lab",
  unit: "caja",
  identityVersion: 4,
  catalogVersion: 7,
};
beforeEach(() => {
  vi.clearAllMocks();
  auth.role = "ADMIN";
});

it.each(["ADMIN", "BODEGA"] as const)(
  "%s resolves reception product 183 independently of the first 100 and keeps quantity and lock",
  async (role) => {
    auth.role = role;
    vi.mocked(getEntryProduct).mockResolvedValue(target);
    const props = formProps(
      await Page({
        searchParams: Promise.resolve({
          productId: "183",
          missingItemId: "missing",
          quantity: "12",
        }),
      }),
    );
    expect(getEntryProduct).toHaveBeenCalledWith("183");
    expect(props).toMatchObject({
      lockedProduct: target,
      missingItemId: "missing",
      selectedQuantity: 12,
    });
    expect(props?.products).toContainEqual(target);
    expect(getProducts).toHaveBeenCalledWith({ take: 100, active: true });
  },
);

it("remounts when the reception changes for the same product and quantity", async () => {
  vi.mocked(getEntryProduct).mockResolvedValue(target);
  const pageFor = async (missingItemId?: string) =>
    formProps(
      await Page({
        searchParams: Promise.resolve({
          productId: target.id,
          quantity: "12",
          missingItemId,
        }),
      }),
    );
  const standalone = await pageFor();
  const firstReception = await pageFor("first");
  const secondReception = await pageFor("second");
  expect(firstReception?.key).not.toBe(standalone?.key);
  expect(secondReception?.key).not.toBe(firstReception?.key);
});

it.each(["OPERADOR", "SUPERVISOR"] as const)(
  "does not expose entry creation or resolve URL products for %s",
  async (role) => {
    auth.role = role;
    const props = formProps(
      await Page({ searchParams: Promise.resolve({ productId: target.id }) }),
    );
    expect(props).toBeUndefined();
    expect(getEntryProduct).not.toHaveBeenCalled();
  },
);

it.each(["0", "-1", "1.5", "invalid"])(
  "ignores invalid suggested quantity %s",
  async (quantity) => {
    vi.mocked(getEntryProduct).mockResolvedValue(target);
    const props = formProps(
      await Page({
        searchParams: Promise.resolve({ productId: target.id, quantity }),
      }),
    );
    expect(props?.selectedQuantity).toBeUndefined();
  },
);
it("does not lock or preselect an inactive or missing URL product", async () => {
  vi.mocked(getEntryProduct).mockResolvedValue(null);
  const props = formProps(
    await Page({
      searchParams: Promise.resolve({
        productId: "inactive",
        missingItemId: "missing",
      }),
    }),
  );
  expect(props?.lockedProduct).toBeUndefined();
  expect(props?.selectedProductId).toBeUndefined();
});

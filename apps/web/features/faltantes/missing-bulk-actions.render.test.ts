import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

vi.mock("@/server/actions/missing-item.actions", () => ({
  discardMissingItemsAction: vi.fn(),
}));

import { MissingBulkActions } from "./missing-bulk-actions";

beforeEach(() => {
  vi.clearAllMocks();
  useActionStateMock.mockReturnValue([{ error: null, ok: false }, vi.fn(), false]);
});

describe("MissingBulkActions", () => {
  it("shows seller code for manual items and the real deficit for automatic items", () => {
    const html = renderToStaticMarkup(
      createElement(MissingBulkActions, {
        items: [
          {
            id: "manual-1",
            productName: "Manual product",
            quantity: null,
            unit: "unidad",
            sellerCode: "VEN-12",
          },
          {
            id: "automatic-1",
            productName: "Automatic product",
            quantity: 4,
            unit: "unidad",
            sellerCode: null,
          },
        ],
      }),
    );

    expect(html).toContain("VEN-12");
    expect(html).toContain("4 unidad");
    expect(html).not.toContain("1 unidad");
  });
});

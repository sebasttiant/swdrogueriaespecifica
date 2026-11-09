import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { MissingItemListEntry } from "@/server/services/missing-item.service";

vi.mock("./missing-quick-actions", () => ({ MissingQuickActions: () => null }));

import { MissingList } from "./missing-list";

const now = new Date("2026-01-01");
const item: MissingItemListEntry = {
  id: "one",
  quantity: 1,
  orderedQuantity: null,
  receivedQuantity: 0,
  note: null,
  status: "FALTANTE",
  originId: null,
  confirmedAt: null,
  confirmedById: null,
  confirmationNote: null,
  orderedAt: null,
  orderedById: null,
  discardedAt: null,
  discardedById: null,
  supplierId: null,
  sellerCode: null,
  createdAt: now,
  product: {
    id: "product",
    name: "Producto",
    code: "P1",
    unit: "unidad",
    laboratory: null,
  },
  origin: null,
  supplier: null,
  confirmedBy: null,
  createdBy: null,
  orderedBy: null,
  discardedBy: null,
  requestedByName: "Solicitante",
  requestedAt: now,
};
const props = {
  items: [item],
  nextCursor: "cursor",
  pageHref: (cursor: string) => `/faltantes?cursor=${cursor}`,
  canQuickAct: false,
  canSeeStatus: false,
  canSeeSupplier: false,
  canSeeRequestedAt: false,
  scope: "actionable" as const,
  now,
};

describe("page-local list headings", () => {
  it("clarifies group counts only when management opts in", () => {
    const html = renderToStaticMarkup(
      createElement(MissingList, {
        ...props,
        pageLocalGroups: true,
        nextCursor: null,
      }),
    );

    expect(html).toContain("En curso en esta página");
    expect(html).toContain("Solicitante");
    expect(html).not.toContain("Ver más");
  });

  it("preserves default headings and cursor links for other consumers", () => {
    const html = renderToStaticMarkup(createElement(MissingList, props));

    expect(html).toContain("En curso");
    expect(html).not.toContain("en esta página");
    expect(html).toContain("Ver más");
    expect(html).toContain("/faltantes?cursor=cursor");
  });
});

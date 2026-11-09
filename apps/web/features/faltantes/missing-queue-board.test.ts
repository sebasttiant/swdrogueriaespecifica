import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/faltantes/missing-list", () => ({
  MissingList: ({
    nextCursor,
    pageLocalGroups,
    bulkMode,
  }: {
    nextCursor: string | null;
    pageLocalGroups?: boolean;
    bulkMode?: boolean;
  }) =>
    createElement("div", {
      "data-testid": "list",
      "data-cursor": nextCursor,
      "data-page-local": pageLocalGroups,
      "data-bulk": bulkMode,
    }),
}));
vi.mock("@/features/faltantes/missing-bulk-actions", () => ({
  MissingBulkActions: ({ children }: { children: ReactNode }) =>
    createElement("form", null, children),
}));
vi.mock("@/features/faltantes/missing-export-actions", () => ({
  MissingExportActions: () => null,
}));

import { MissingQueueBoard } from "./missing-queue-board";
import { PENDING_SUPPLY_ROUTE, SHELF_BOARD_ROUTE } from "./missing-scope";

const props = {
  items: [],
  nextCursor: "legacy",
  scope: "actionable" as const,
  canAct: true,
  canExport: false,
  canSeeSupplier: true,
  canSeeRequestedAt: true,
  now: new Date(),
  route: SHELF_BOARD_ROUTE,
  label: "Vista",
  bulkMode: false,
};

describe("management board opt-in", () => {
  it("renders both pagers around the list and keeps bulk working", () => {
    const html = renderToStaticMarkup(
      createElement(MissingQueueBoard, {
        ...props,
        bulkMode: true,
        managementPage: { page: 2, pageSize: 50, total: 195 },
      }),
    );

    expect(html.match(/Mostrando 51–100 de 195/g)).toHaveLength(2);
    const listAt = html.indexOf('data-testid="list"');
    expect(html.indexOf("Mostrando")).toBeLessThan(listAt);
    expect(html.lastIndexOf("Mostrando")).toBeGreaterThan(listAt);
    expect(html).toContain('data-page-local="true"');
    expect(html).toContain('data-bulk="true"');
    expect(html).not.toContain("data-cursor=");
    expect(html).toContain("bulk=1&amp;qpage=3");
  });

  it("leaves non-opted-in consumers on their cursor contract", () => {
    const html = renderToStaticMarkup(
      createElement(MissingQueueBoard, {
        ...props,
        route: PENDING_SUPPLY_ROUTE,
      }),
    );

    expect(html).not.toContain("Mostrando");
    expect(html).toContain('data-cursor="legacy"');
    expect(html).toContain('data-page-local="false"');
    expect(html).toContain(
      "/revision-pendientes?tab=abastecimiento&amp;sbulk=1",
    );
  });
});

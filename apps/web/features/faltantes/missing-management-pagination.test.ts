import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MissingManagementPagination,
  parseMissingManagementPage,
} from "./missing-management-pagination";
import { missingScopeHref, SHELF_BOARD_ROUTE } from "./missing-scope";

const route = {
  ...SHELF_BOARD_ROUTE,
  persistentParams: { demora: "8h" },
};

function render(page: number, total = 195) {
  return renderToStaticMarkup(
    createElement(MissingManagementPagination, {
      page,
      total,
      pageSize: 50,
      scope: "ordered",
      route,
      bulkMode: true,
    }),
  );
}

describe("management pagination", () => {
  it.each([
    [1, "1–50"],
    [2, "51–100"],
    [3, "101–150"],
    [4, "151–195"],
  ])("shows page %s range", (page, range) => {
    expect(render(Number(page))).toContain(`Mostrando ${range} de 195`);
  });

  it("uses disabled buttons at boundaries, not clickable links", () => {
    expect(render(1)).toMatch(
      /<button[^>]*disabled=""[^>]*>Anterior<\/button>/,
    );
    expect(render(1)).toContain("qpage=2");
    expect(render(4)).toMatch(
      /<button[^>]*disabled=""[^>]*>Siguiente<\/button>/,
    );
    expect(render(4)).toContain("qpage=3");
    expect(render(1, 0)).toContain("Mostrando 0–0 de 0");
    expect(render(1, 0).match(/disabled=""/g)).toHaveLength(2);
    expect(render(1, 50).match(/disabled=""/g)).toHaveLength(2);
  });

  it("preserves filters and bulk with an isolated qpage parameter", () => {
    const html = render(2);

    expect(html).toContain(
      "/revision-faltantes?demora=8h&amp;scope=ordered&amp;bulk=1&amp;qpage=3",
    );
    expect(html).not.toContain("cursor=");
    expect(html).toContain("flex-wrap");

    const filterUrl = missingScopeHref("discarded", route, true);
    expect(filterUrl).toBe(
      "/revision-faltantes?demora=8h&scope=discarded&bulk=1",
    );
    expect(missingScopeHref("ordered", SHELF_BOARD_ROUTE, true)).not.toContain(
      "qpage",
    );
  });

  it.each([
    undefined,
    "",
    "0",
    "-1",
    "1.5",
    "1e2",
    "abc",
    "999999999999999999999",
  ])("normalizes invalid %s", (raw) => {
    expect(parseMissingManagementPage(raw)).toBe(1);
  });

  it("accepts safe positive pages", () => {
    expect(parseMissingManagementPage("4")).toBe(4);
  });
});

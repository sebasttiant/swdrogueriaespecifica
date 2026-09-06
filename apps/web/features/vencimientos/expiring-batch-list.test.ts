/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ExpiringBatchListItem } from "@/server/repositories/product-batch.repository";

import { ExpiringBatchList } from "./expiring-batch-list";

// 2026-06-09 17:00 UTC = 2026-06-09 12:00 Bogotá.
const NOW = new Date("2026-06-09T17:00:00.000Z");
const bogotaMidday = (ymd: string) => new Date(`${ymd}T17:00:00.000Z`);

function batch(over: Partial<ExpiringBatchListItem> = {}): ExpiringBatchListItem {
  return {
    id: "b1",
    batchCode: "L-4471",
    expiresAt: bogotaMidday("2026-06-04"),
    quantity: 12,
    location: null,
    status: "DISPONIBLE",
    product: { id: "p1", name: "Dolex 500 mg x 24", code: "MED-001", unit: "Caja" },
    ...over,
  };
}

afterEach(cleanup);

describe("ExpiringBatchList", () => {
  it("says what an empty tier means instead of showing a blank page", () => {
    render(
      createElement(ExpiringBatchList, {
        tier: "warning",
        items: [],
        nextCursor: null,
        now: NOW,
      }),
    );

    expect(screen.getByText("Nada vence en los próximos tres meses")).toBeTruthy();
  });

  // Lo que la pantalla existe para responder: CUÁLES son los lotes. El número
  // del lote, el producto, la fecha y cuánto falta, sin entrar a ningún lado.
  it("shows the batch, the product, the date and the countdown", () => {
    render(
      createElement(ExpiringBatchList, {
        tier: "expired",
        items: [batch()],
        nextCursor: null,
        now: NOW,
      }),
    );

    const table = screen.getByRole("table");
    const row = within(table).getByRole("row", { name: /Dolex 500 mg x 24/ });

    expect(within(row).getByText("L-4471")).toBeTruthy();
    expect(within(row).getByText("Venció hace 5 días")).toBeTruthy();
    expect(within(row).getByText("12 Caja")).toBeTruthy();
  });

  it("links each row to its product", () => {
    render(
      createElement(ExpiringBatchList, {
        tier: "expired",
        items: [batch()],
        nextCursor: null,
        now: NOW,
      }),
    );

    const links = screen
      .getAllByRole("link", { name: "Dolex 500 mg x 24" })
      .map((link) => link.getAttribute("href"));

    expect(new Set(links)).toEqual(new Set(["/productos/p1"]));
  });

  // El orden lo fija la consulta (el que vence antes, primero). La lista NO
  // reordena: si lo hiciera, la segunda página empezaría en otro lado que el
  // cursor y se saltearían filas.
  it("renders the rows in the order it received them", () => {
    render(
      createElement(ExpiringBatchList, {
        tier: "critical",
        items: [
          batch({ id: "b1", batchCode: "L-1", expiresAt: bogotaMidday("2026-06-10") }),
          batch({ id: "b2", batchCode: "L-2", expiresAt: bogotaMidday("2026-06-20") }),
          batch({ id: "b3", batchCode: "L-3", expiresAt: bogotaMidday("2026-07-01") }),
        ],
        nextCursor: null,
        now: NOW,
      }),
    );

    const table = screen.getByRole("table");
    const codes = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelectorAll("td")[1]?.textContent);

    expect(codes).toEqual(["L-1", "L-2", "L-3"]);
  });

  // Sin el `tier`, "Ver más" caería en la franja por defecto y la segunda
  // página mostraría lotes de otra ventana que la primera.
  it("keeps the tier in the next-page link", () => {
    render(
      createElement(ExpiringBatchList, {
        tier: "warning",
        items: [batch()],
        nextCursor: "cursor-2",
        now: NOW,
      }),
    );

    expect(screen.getByRole("link", { name: "Ver más" }).getAttribute("href")).toBe(
      "/vencimientos?tier=warning&cursor=cursor-2",
    );
  });

  it("offers no next-page link on the last page", () => {
    render(
      createElement(ExpiringBatchList, {
        tier: "warning",
        items: [batch()],
        nextCursor: null,
        now: NOW,
      }),
    );

    expect(screen.queryByRole("link", { name: "Ver más" })).toBeNull();
  });
});

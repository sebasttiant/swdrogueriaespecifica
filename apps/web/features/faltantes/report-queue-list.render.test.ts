import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { MissingReportQueueGroup } from "@/server/services/missing-report.service";

import { ReportQueueList } from "./report-queue-list";

function report(
  id: string,
  rawName: string,
  createdAt: string,
  reporterName: string | null = "Ana Vendedora",
) {
  return {
    id,
    rawName,
    normalizedName: rawName.toLowerCase(),
    createdAt: new Date(createdAt),
    reporter: reporterName ? { id: `u-${id}`, name: reporterName } : null,
  };
}

function group(overrides: Partial<MissingReportQueueGroup> = {}): MissingReportQueueGroup {
  return {
    normalizedName: "acetaminofén 500",
    displayName: "Acetaminofén 500mg",
    count: 1,
    latestReportedAt: new Date("2026-07-20T14:00:00.000Z"),
    reports: [report("r1", "Acetaminofén 500mg", "2026-07-20T14:00:00.000Z")],
    ...overrides,
  };
}

function render(
  groups: MissingReportQueueGroup[],
  options: Partial<{ page: number; hasMore: boolean }> = {},
): string {
  return renderToStaticMarkup(
    createElement(ReportQueueList, {
      groups,
      page: options.page ?? 1,
      hasMore: options.hasMore ?? false,
    }),
  );
}

describe("ReportQueueList · empty", () => {
  it("shows an empty state when nothing is pending review", () => {
    const html = render([]);

    expect(html).toContain("No hay reportes pendientes");
    expect(html).not.toContain("Reportado");
  });
});

describe("ReportQueueList · groups", () => {
  it("shows the original product name, not the internal normalized one", () => {
    const html = render([
      group({ displayName: "Acetaminofén 500mg", normalizedName: "acetaminofén 500mg" }),
    ]);

    expect(html).toContain("Acetaminofén 500mg");
    // El nombre normalizado es interno: sirve para agrupar, no se muestra.
    expect(html).not.toContain("acetaminofén 500mg");
  });

  it("states how many times the product was reported", () => {
    const html = render([group({ count: 4 })]);

    expect(html).toContain("Reportado 4 veces");
  });

  it("uses the singular for a single report", () => {
    const html = render([group({ count: 1 })]);

    expect(html).toContain("Reportado 1 vez");
    expect(html).not.toContain("1 veces");
  });

  it("shows the date of the most recent report in Bogota time", () => {
    const latest = new Date("2026-07-20T14:00:00.000Z");
    const html = render([group({ latestReportedAt: latest })]);

    expect(html).toContain(formatBogotaDate(latest, { style: "datetime" }));
  });

  it("renders a group whose latest date did not resolve, without breaking", () => {
    const html = render([group({ latestReportedAt: null })]);

    expect(html).toContain("Acetaminofén 500mg");
  });
});

describe("ReportQueueList · individual history", () => {
  it("keeps every reporter, original name and date behind a disclosure", () => {
    const html = render([
      group({
        count: 2,
        reports: [
          report("r1", "Acetaminofén 500mg", "2026-07-20T14:00:00.000Z", "Ana Vendedora"),
          report("r2", "acetaminofen 500", "2026-07-19T09:00:00.000Z", "Beto Mostrador"),
        ],
      }),
    ]);

    expect(html).toContain("<details");
    expect(html).toContain("Ana Vendedora");
    expect(html).toContain("Beto Mostrador");
    expect(html).toContain("acetaminofen 500");
    expect(html).toContain(
      formatBogotaDate(new Date("2026-07-19T09:00:00.000Z"), { style: "datetime" }),
    );
  });

  it("renders a report whose reporter did not resolve, without inventing a name", () => {
    const html = render([
      group({ reports: [report("r1", "Gasa estéril", "2026-07-20T14:00:00.000Z", null)] }),
    ]);

    expect(html).toContain("Gasa estéril");
    expect(html).toContain("Reportante no disponible");
  });
});

describe("ReportQueueList · pagination", () => {
  it("offers the next page only when there is more to show", () => {
    expect(render([group()], { page: 1, hasMore: true })).toContain(
      "/revision-faltantes?page=2",
    );
    expect(render([group()], { page: 1, hasMore: false })).not.toContain("page=2");
  });

  it("offers the previous page only after the first", () => {
    const first = render([group()], { page: 1, hasMore: true });
    expect(first).not.toContain("Anterior");

    const second = render([group()], { page: 2, hasMore: false });
    expect(second).toContain("Anterior");
    // La primera página vive en la ruta limpia, sin ?page=1.
    expect(second).toContain('href="/revision-faltantes"');
  });

  it("shows the current page number", () => {
    expect(render([group()], { page: 3 })).toContain("Página 3");
  });
});

describe("ReportQueueList · read-only", () => {
  // D1d-2 es solo lectura: vincular a un producto y crear el faltante canónico
  // es D1e. No debe haber ningún control de mutación todavía.
  it("offers no mutation controls", () => {
    const html = render([group()], { page: 1, hasMore: true });

    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Vincular");
    expect(html).not.toContain("Descartar");
    expect(html).not.toContain("Crear faltante");
  });

  it("never exposes a reporter's internal id in the visible text", () => {
    const html = render([
      group({ reports: [report("r1", "Gasa", "2026-07-20T14:00:00.000Z", "Ana")] }),
    ]);

    expect(html).not.toContain("u-r1");
  });
});

describe("ReportQueueList · long names", () => {
  it("lets a very long pasted name wrap instead of overflowing", () => {
    const long = "Acetaminofén ".repeat(20).trim();
    const html = render([group({ displayName: long })]);

    expect(html).toContain("break-words");
  });
});

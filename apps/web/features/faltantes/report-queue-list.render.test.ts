import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/actions/missing-report.actions", () => ({
  linkMissingReportToProductAction: vi.fn(),
  resolveMissingReportsAction: vi.fn(),
}));
vi.mock("@/server/actions/missing-item.actions", () => ({
  searchActiveProductsForMissingItemAction: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useActionState: () => [{ error: null, ok: false }, vi.fn(), false],
  };
});

import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { MissingReportQueueGroup } from "@/server/services/missing-report.service";

import { ReportQueueList } from "./report-queue-list";

function report(
  id: string,
  rawName: string,
  createdAt: string,
  reporterName: string | null = "Ana Vendedora",
  sellerCode: string | null = null,
) {
  return {
    id,
    rawName,
    normalizedName: rawName.toLowerCase(),
    sellerCode,
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

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
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

  it("shows the optional seller code beside the reporter name", () => {
    const html = render([
      group({ reports: [report("r1", "Gasa estéril", "2026-07-20T14:00:00.000Z", "Ana", "VEN-12")] }),
    ]);

    expect(html).toContain("Ana · VEN-12");
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

describe("ReportQueueList · superficie de mutación", () => {
  // La cola ofrece TRES salidas y ninguna más: pedir, descartar y vincular al
  // catálogo. Lo que sigue estando prohibido acá es pedir datos de compra:
  // cantidad y proveedor son decisiones posteriores, y meterlas en esta pantalla
  // es exactamente lo que volvió inusable la cola de faltantes.
  it("ofrece las tres salidas, sin pedir datos de compra", () => {
    const html = render([group()], { page: 1, hasMore: true });

    expect(html).toContain("Ya lo pedí");
    expect(html).toContain("Descartar");
    expect(html).toContain("Vincular producto");

    expect(html).not.toContain("Crear faltante");
    expect(html).not.toContain('name="quantity"');
    expect(html).not.toContain('name="orderedQuantity"');
    expect(html).not.toContain('name="supplierId"');
    expect(html).not.toContain("Cantidad a pedir");
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

describe("ReportQueueList · linking", () => {
  it("offers a link form for each group", () => {
    const html = render([
      group({ normalizedName: "a", displayName: "A", reports: [report("r1", "A", "2026-07-20T10:00:00.000Z")] }),
      group({ normalizedName: "b", displayName: "B", reports: [report("r2", "B", "2026-07-19T10:00:00.000Z")] }),
    ]);

    expect(countOccurrences(html, "Vincular producto")).toBe(2);
  });

  // El form nace colapsado, así que los ids ocultos todavía no se montan: eso se
  // verifica en el test del propio form. Acá lo observable es que cada grupo
  // tenga SU form, uno por tarjeta.
  it("gives every group its own form, one per card", () => {
    const html = render([
      group({
        normalizedName: "a",
        displayName: "A",
        reports: [
          report("r1", "A", "2026-07-20T10:00:00.000Z"),
          report("r2", "A", "2026-07-19T10:00:00.000Z"),
        ],
      }),
    ]);

    expect(countOccurrences(html, "Vincular producto")).toBe(1);
  });

  it("shows no link form when the queue is empty", () => {
    const html = render([]);

    expect(html).not.toContain("Vincular producto");
  });
});

// --------------------------------------------------------------------------
// El reclamo de gerencia (2026-07-30): la cola solo crecía. Vincular al catálogo
// era la ÚNICA salida, así que un producto que el vendedor pegó desde Orión y no
// estaba cargado dejaba el reporte atrapado para siempre.
// --------------------------------------------------------------------------
describe("ReportQueueList · salidas rápidas", () => {
  it("ofrece resolver el grupo sin pasar por el catálogo", () => {
    const html = render([group({ displayName: "TIAMINA 300 MG" })]);

    expect(html).toContain("Ya lo pedí");
    expect(html).toContain("Descartar");
  });

  // Las dos acciones significan cosas OPUESTAS: una afirma que se compró, la
  // otra que nadie lo va a pedir. Viajan como valores distintos, no como un
  // "OK" ambiguo que después nadie pueda interpretar.
  it("manda resoluciones distintas para pedir y para descartar", () => {
    const html = render([group({})]);

    expect(html).toContain('name="resolution" value="ORDERED"');
    expect(html).toContain('name="resolution" value="DISCARDED"');
  });

  // La unidad operativa es el GRUPO: marcar "uno de los cuatro reportes de
  // tiamina" no significa nada. Cada form lleva todos los ids del grupo.
  it("resuelve el grupo entero, nunca un reporte suelto", () => {
    const html = render([
      group({
        reports: [
          report("r-1", "Tiamina", "2026-07-30T09:00:00.000Z"),
          report("r-2", "Tiamina", "2026-07-30T09:10:00.000Z"),
          report("r-3", "Tiamina", "2026-07-30T09:20:00.000Z"),
        ],
      }),
    ]);

    for (const id of ["r-1", "r-2", "r-3"]) {
      expect(html).toContain(`name="reportIds" value="${id}"`);
    }
  });

  // Vincular no desaparece: baja a segundo plano, colapsado, para quien quiera
  // seguimiento de stock del producto.
  it("conserva el vínculo al catálogo como acción secundaria", () => {
    const html = render([group({})]);

    expect(html).toContain("Vincular a un producto del catálogo");
  });

  // Con varias tarjetas en pantalla, "Ya lo pedí" a secas no dice cuál.
  it("nombra el producto en el rótulo accesible de cada acción", () => {
    const html = render([group({ displayName: "TIAMINA 300 MG" })]);

    expect(html).toContain("Marcar TIAMINA 300 MG como pedido");
    expect(html).toContain("Descartar TIAMINA 300 MG");
  });
});

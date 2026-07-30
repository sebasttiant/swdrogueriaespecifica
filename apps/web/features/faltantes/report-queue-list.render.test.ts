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
  options: Partial<{
    page: number;
    hasMore: boolean;
    scope: "pending" | "ordered" | "discarded";
  }> = {},
): string {
  return renderToStaticMarkup(
    createElement(ReportQueueList, {
      groups,
      page: options.page ?? 1,
      hasMore: options.hasMore ?? false,
      scope: options.scope ?? "pending",
      emptyTitle: "No hay reportes pendientes",
      emptyDescription: "Cuando un vendedor reporte un faltante, aparece acá.",
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
    // La clave canónica solo viaja como valor hidden, nunca como copy visible.
    expect(html).not.toContain(">acetaminofén 500mg<");
  });

  it("states how many times the product was reported", () => {
    const html = render([group({ count: 4 })]);

    // Texto corto: la fila tiene que caber en un renglón.
    expect(html).toContain("4 reportes");
  });

  it("uses the singular for a single report", () => {
    const html = render([group({ count: 1 })]);

    expect(html).toContain("1 reporte");
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
  // Gerencia descartó vincular al catálogo (Daniel, 2026-07-30): buscar el
  // producto demora demasiado para el ritmo de la cola. La pantalla ofrece dos
  // salidas y NINGUNA pide datos de compra.
  it("ofrece las dos salidas, sin catálogo ni datos de compra", () => {
    const html = render([group()], { page: 1, hasMore: true });

    expect(html).toContain("Ya lo pedí");
    expect(html).toContain("Descartar");

    expect(html).not.toContain("Vincular");
    expect(html).not.toContain("Crear faltante");
    expect(html).not.toContain('name="productId"');
    expect(html).not.toContain('name="quantity"');
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

  it("identifies the group by its canonical key, never client-selected report ids", () => {
    const html = render([
      group({
        reports: [
          report("r-1", "Tiamina", "2026-07-30T09:00:00.000Z"),
          report("r-2", "Tiamina", "2026-07-30T09:10:00.000Z"),
          report("r-3", "Tiamina", "2026-07-30T09:20:00.000Z"),
        ],
      }),
    ]);

    // Dos formularios: pedir y descartar. Vincular ya no existe.
    expect(countOccurrences(html, 'name="normalizedName" value="acetaminofén 500"')).toBe(2);
    expect(html).not.toContain('name="reportIds"');
  });

  // Vincular no desaparece: baja a segundo plano, colapsado, para quien quiera
  // seguimiento de stock del producto.

  // Con varias tarjetas en pantalla, "Ya lo pedí" a secas no dice cuál.
  it("nombra el producto en el rótulo accesible de cada acción", () => {
    const html = render([group({ displayName: "TIAMINA 300 MG" })]);

    expect(html).toContain("Marcar TIAMINA 300 MG como pedido");
    expect(html).toContain("Descartar TIAMINA 300 MG");
  });
});

// --------------------------------------------------------------------------
// Las mismas tres vistas que /faltantes, con las mismas palabras. Lo resuelto
// no se borra: se consulta al lado.
// --------------------------------------------------------------------------
describe("ReportQueueList · vistas", () => {
  it("en 'ya pedidos' ofrece cerrar el ciclo, no volver a pedir", () => {
    const html = render([group()], { scope: "ordered" });

    expect(html).toContain("Ya llegó");
    expect(html).not.toContain("Ya lo pedí");
    expect(html).not.toContain("Descartar");
  });

  // El compare-and-set: solo se marca recibido lo que estaba PEDIDO. Sin esto
  // se podría cerrar algo que nadie compró.
  it("el 'ya llegó' exige que el reporte siguiera pedido", () => {
    const html = render([group()], { scope: "ordered" });

    expect(html).toContain('name="resolution" value="RECEIVED"');
    expect(html).toContain('name="expectedStatus" value="ORDERED"');
  });

  // Ya se decidió que no se pide: ofrecer una acción sería invitar a un toque
  // que el servidor va a rechazar.
  it("en 'descartados' no ofrece ninguna acción", () => {
    const html = render([group()], { scope: "discarded" });

    expect(html).not.toContain("Ya lo pedí");
    expect(html).not.toContain("Descartar ");
    expect(html).not.toContain("Ya llegó");
  });

  it("conserva la pestaña al pasar de página", () => {
    const html = render([group()], { scope: "discarded", page: 1, hasMore: true });

    expect(html).toContain("scope=discarded");
    expect(html).toContain("page=2");
  });

  // Un vacío genérico haría dudar de si la acción se guardó.
  it("usa el vacío que le pasa la pestaña activa", () => {
    expect(render([])).toContain("No hay reportes pendientes");
  });
});

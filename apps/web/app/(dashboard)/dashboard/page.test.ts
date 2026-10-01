import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  getPendingDashboard: vi.fn(),
  getOpenMissingCount: vi.fn(),
  getExpiringBatchCounts: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireCapability: mocks.requireCapability,
}));
vi.mock("@/server/services/pending.service", () => ({
  getPendingDashboard: mocks.getPendingDashboard,
}));
vi.mock("@/server/services/missing-item.service", () => ({
  getOpenMissingCount: mocks.getOpenMissingCount,
}));
vi.mock("@/server/services/product-batch.service", () => ({
  getExpiringBatchCounts: mocks.getExpiringBatchCounts,
}));

import DashboardPage from "./page";

const GERENCIA = { user: { id: "admin-1", role: "ADMIN" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCapability.mockResolvedValue(GERENCIA);
  mocks.getPendingDashboard.mockResolvedValue({
    openCount: 0,
    overdueCount: 0,
    upcomingCount: 0,
    urgent: [],
  });
  mocks.getExpiringBatchCounts.mockResolvedValue({ critical: 0, warning: 0 });
  // Un número DISTINTO por eje: así el test puede probar que cada tarjeta
  // muestra el suyo y no que los dos coinciden por casualidad.
  mocks.getOpenMissingCount.mockImplementation(async (origin: string) =>
    origin === "shelf" ? 12 : 35,
  );
});

// --------------------------------------------------------------------------
// El KPI de faltantes sumaba dos negocios: reposición de estantería y producto
// comprometido con un cliente. Decía 47, y al entrar a la cola aparecían 12.
// Un número que no cuadra con ninguna pantalla no orienta: enseña a
// desconfiar del tablero.
// --------------------------------------------------------------------------
describe("DashboardPage · los dos negocios no se suman", () => {
  it("pide los dos ejes por separado, nunca el total", async () => {
    await DashboardPage();

    expect(mocks.getOpenMissingCount).toHaveBeenCalledWith("shelf");
    expect(mocks.getOpenMissingCount).toHaveBeenCalledWith("pending");
    expect(mocks.getOpenMissingCount).not.toHaveBeenCalledWith();
    expect(mocks.getOpenMissingCount).not.toHaveBeenCalledWith("all");
  });

  it("no muestra el total sumado en ninguna tarjeta", async () => {
    const html = renderToStaticMarkup(await DashboardPage());

    expect(html).toContain("Faltantes de estantería");
    expect(html).toContain("Pendientes por abastecer");
    // 12 + 35. Si aparece, alguien volvió a fundir los dos negocios.
    expect(html).not.toContain(">47<");
  });

  // EL TEST QUE PEDIMOS: cada tarjeta tiene que llevar a la pantalla donde vive
  // EXACTAMENTE la población que muestra. El enlace viejo iba a `/faltantes`,
  // que desde la mudanza del tablero es la pantalla de captura y no tiene cola:
  // prometía gestión y no daba dónde tocar.
  it("cada KPI enlaza a la pantalla que muestra esa misma población", async () => {
    const html = renderToStaticMarkup(await DashboardPage());
    // Solo la franja de indicadores: los atajos de abajo tienen otro trabajo.
    // "Nuevo faltante" SÍ debe ir a /faltantes, que es la pantalla de captura.
    const kpis = html.slice(
      html.indexOf('aria-label="Indicadores principales"'),
      html.indexOf('aria-label="Acciones rápidas"'),
    );

    // La estantería se trabaja en Revisión de faltantes, ya acotada a `shelf`.
    expect(kpis).toContain('href="/revision-faltantes"');
    // Lo de clientes, en la mitad de abastecimiento de Revisión de pendientes,
    // acotada a `pending`. Con la pestaña puesta: sin ella cae en seguimiento,
    // que muestra otra cosa.
    expect(kpis).toContain("/revision-pendientes?tab=abastecimiento");
    // Ningún KPI manda ya a la pantalla de captura, que no tiene cola: prometía
    // gestión y no daba dónde tocar.
    expect(kpis).not.toContain('href="/faltantes"');
  });
});

// --------------------------------------------------------------------------
// Lectura global (2026-09-30): el vendedor ve las métricas de toda la cola, y
// la identidad de los urgentes se decide fila por fila en el service.
// --------------------------------------------------------------------------
describe("DashboardPage · alcance e identidad", () => {
  it.each([
    ["OPERADOR", "vendedor-1"],
    ["BODEGA", "bodega-1"],
    ["SUPERVISOR", "supervisor-1"],
    ["ADMIN", "admin-1"],
  ] as const)("%s: métricas globales y quién mira para la identidad", async (role, id) => {
    mocks.requireCapability.mockResolvedValue({ user: { id, role } });

    await DashboardPage();

    expect(mocks.getPendingDashboard).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "global",
        ownerId: undefined,
        identityViewer: { role, userId: id },
      }),
    );
    expect(mocks.getPendingDashboard.mock.calls[0]![0]).not.toHaveProperty(
      "canViewCustomerIdentity",
    );
  });
});

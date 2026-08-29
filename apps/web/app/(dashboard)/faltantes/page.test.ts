import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  getMissingItemsSummary: vi.fn(),
  getMyMissingReports: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireCapability: mocks.requireCapability,
}));
vi.mock("@/server/services/missing-item.service", () => ({
  getMissingItemsSummary: mocks.getMissingItemsSummary,
}));
vi.mock("@/server/services/missing-report.service", () => ({
  getMyMissingReports: mocks.getMyMissingReports,
}));

import FaltantesPage from "./page";

// `can` NO se mockea a propósito: el test ejercita la matriz REAL de
// capacidades. Si mañana alguien le da o le saca una capacidad a un rol, este
// test tiene que enterarse.
const ROLES = ["SUPERADMIN", "ADMIN", "SUPERVISOR", "OPERADOR", "BODEGA"] as const;

function sesion(role: (typeof ROLES)[number]) {
  mocks.requireCapability.mockResolvedValue({ user: { id: `u-${role}`, role } });
}

beforeEach(() => {
  vi.clearAllMocks();
  sesion("ADMIN");
  mocks.getMissingItemsSummary.mockResolvedValue({
    open: 0,
    overdue: null,
    ordered: 0,
    confirmed: 0,
  });
  mocks.getMyMissingReports.mockResolvedValue([]);
});

// --------------------------------------------------------------------------
// La regla del negocio: TODOS los perfiles reportan un faltante, y solo
// gerencia (ADMIN/SUPERADMIN) lo revisa para comprar. Bodega no compra: recibe.
// --------------------------------------------------------------------------
describe("FaltantesPage · quién reporta y quién revisa", () => {
  it.each(ROLES)("%s puede reportar un faltante", async (role) => {
    sesion(role);

    const html = renderToStaticMarkup(await FaltantesPage());

    expect(html).toContain("Reportar faltante");
  });

  // El alta catalogada es otro eje: exige elegir un producto del catálogo y es
  // de gerencia. El reporte básico —pegar el nombre desde Orión— es de todos.
  it.each(["SUPERVISOR", "OPERADOR", "BODEGA"] as const)(
    "%s NO ve el alta catalogada de gerencia",
    async (role) => {
      sesion(role);

      const html = renderToStaticMarkup(await FaltantesPage());

      expect(html).not.toContain("Alta manual catalogada");
    },
  );

  it.each(["SUPERADMIN", "ADMIN"] as const)(
    "%s sí ve el alta catalogada",
    async (role) => {
      sesion(role);

      const html = renderToStaticMarkup(await FaltantesPage());

      expect(html).toContain("Alta manual catalogada");
    },
  );

  // EL DEFECTO QUE ESTO CIERRA. SUPERVISOR tiene `canConfirmMissingItems`, que
  // antes destapaba este atajo. Pero el guard de /revision-faltantes exige
  // `canReceiveMissingItems`, que no tiene: tocaba el enlace y el guard lo
  // rebotaba al dashboard sin explicación. El atajo tiene que ofrecerse con la
  // MISMA capacidad que abre la puerta, nunca con una parecida.
  it.each(["SUPERVISOR", "OPERADOR"] as const)(
    "%s NO ve un atajo a una pantalla que el guard le va a negar",
    async (role) => {
      sesion(role);

      const html = renderToStaticMarkup(await FaltantesPage());

      expect(html).not.toContain('href="/revision-faltantes"');
    },
  );

  // Los tres que el guard sí deja entrar: gerencia a decidir qué pedir, y
  // bodega a marcar lo que llega.
  it.each(["SUPERADMIN", "ADMIN", "BODEGA"] as const)(
    "%s sí ve el atajo, porque el guard lo deja entrar",
    async (role) => {
      sesion(role);

      const html = renderToStaticMarkup(await FaltantesPage());

      expect(html).toContain('href="/revision-faltantes"');
    },
  );

  // Si la pantalla dice "Faltantes", el número es de faltantes de estantería.
  // Global decía 47 y la cola mostraba 12: los otros 35 eran de clientes.
  it("cuenta solo la reposición de estantería", async () => {
    await FaltantesPage();

    expect(mocks.getMissingItemsSummary).toHaveBeenCalledWith(
      expect.any(Date),
      "shelf",
    );
  });

  // "Vencido" se mide contra la fecha prometida a un cliente. La estantería no
  // le promete nada a nadie: el chip se omite en vez de quedar clavado en 0.
  it("no pinta el chip de vencidos, que en estantería sería siempre cero", async () => {
    const html = renderToStaticMarkup(await FaltantesPage());

    expect(html).toContain("Abiertos");
    expect(html).not.toContain("Vencidos");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// --------------------------------------------------------------------------
// La vista de archivados es de SUPERADMIN, y eso se decide en el SERVIDOR.
//
// Esconder el enlace no autoriza nada: cualquiera puede escribir
// `/admin?archived=true` en la barra de direcciones. Lo que importa es qué
// consulta sale hacia la base, y por eso la prueba mira exactamente eso.
// --------------------------------------------------------------------------

const { requireCapability, getUsers } = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  getUsers: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireCapability }));
vi.mock("@/server/services/user.service", () => ({ getUsers }));

import AdminPage from "./page";

function sesion(role: "SUPERADMIN" | "ADMIN") {
  return { user: { id: "u1", email: "a@x.com", name: "Quien sea", role } };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUsers.mockResolvedValue({ items: [], nextCursor: null });
});

/** Lo que la página terminó pidiéndole a la base. */
function consultaPedida() {
  return getUsers.mock.calls[0]![0];
}

describe("AdminPage · quién puede ver archivados", () => {
  it("SUPERADMIN puede pedir la vista archivada", async () => {
    requireCapability.mockResolvedValue(sesion("SUPERADMIN"));

    await AdminPage({ searchParams: Promise.resolve({ archived: "true" }) });

    expect(consultaPedida().archived).toBe(true);
  });

  // El corazón: aunque ADMIN escriba la URL a mano, la consulta que sale pide
  // la vista operativa. Los archivados no se cargan, así que no hay nada que
  // exponer por accidente.
  it("ADMIN no accede a archivados aunque escriba la URL", async () => {
    requireCapability.mockResolvedValue(sesion("ADMIN"));

    await AdminPage({ searchParams: Promise.resolve({ archived: "true" }) });

    expect(consultaPedida().archived).toBe(false);
  });

  it("a ADMIN se le respetan los demás filtros, solo cae el de archivados", async () => {
    requireCapability.mockResolvedValue(sesion("ADMIN"));

    await AdminPage({
      searchParams: Promise.resolve({ archived: "true", q: "ana", role: "BODEGA" }),
    });

    expect(consultaPedida()).toMatchObject({
      archived: false,
      q: "ana",
      role: "BODEGA",
    });
  });

  it("SUPERADMIN normaliza el estado cuando la vista efectiva es archivada", async () => {
    requireCapability.mockResolvedValue(sesion("SUPERADMIN"));

    await AdminPage({
      searchParams: Promise.resolve({ archived: "true", status: "activos" }),
    });

    expect(consultaPedida()).toMatchObject({
      archived: true,
      status: undefined,
    });
  });

  it("ADMIN conserva el estado cuando se le niega la vista archivada", async () => {
    requireCapability.mockResolvedValue(sesion("ADMIN"));

    await AdminPage({
      searchParams: Promise.resolve({ archived: "true", status: "activos" }),
    });

    expect(consultaPedida()).toMatchObject({
      archived: false,
      status: "activos",
    });
  });

  it("exige la capability antes de consultar nada", async () => {
    requireCapability.mockRejectedValue(new Error("redirect"));

    await expect(
      AdminPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("redirect");
    expect(getUsers).not.toHaveBeenCalled();
  });

  it("sin parámetros pide la vista operativa", async () => {
    requireCapability.mockResolvedValue(sesion("SUPERADMIN"));

    await AdminPage({ searchParams: Promise.resolve({}) });

    expect(consultaPedida()).toMatchObject({ archived: false });
    expect(consultaPedida().q).toBeUndefined();
  });
});

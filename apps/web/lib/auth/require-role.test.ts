import { beforeEach, describe, expect, it, vi } from "vitest";

// La autorización DB-authoritative compone redirect + sesión JWT + lectura de
// base. Mockeamos cada borde; `redirect` lanza (como en Next) para cortar flujo.
const { redirect, getCurrentSession, findUserById } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  getCurrentSession: vi.fn(),
  findUserById: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("./index.node", () => ({ getCurrentSession }));
vi.mock("@/server/repositories/user.repository", () => ({ findUserById }));

import { hasRole, requireActiveRole, requireCapability } from "./require-role";

describe("hasRole", () => {
  it("permite cuando el rol está en la lista", () => {
    expect(hasRole("ADMIN", ["ADMIN"])).toBe(true);
    expect(hasRole("SUPERADMIN", ["SUPERADMIN", "ADMIN"])).toBe(true);
  });

  it("niega cuando el rol no está en la lista", () => {
    expect(hasRole("OPERADOR", ["SUPERADMIN", "ADMIN"])).toBe(false);
  });

  it("niega con lista vacía de roles permitidos", () => {
    expect(hasRole("ADMIN", [])).toBe(false);
  });
});

describe("requireActiveRole (DB-authoritative)", () => {
  const session = {
    user: { id: "u1", email: "a@x.com", name: "A", role: "ADMIN" as const },
  };
  const dbUser = {
    id: "u1",
    email: "a@x.com",
    name: "A",
    role: "ADMIN" as const,
    active: true,
    archivedAt: null,
    createdAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirige a /login si no hay sesión", async () => {
    getCurrentSession.mockResolvedValue(null);
    await expect(requireActiveRole("ADMIN")).rejects.toThrow("REDIRECT:/login");
  });

  it("redirige a /login si el usuario ya no existe en la base", async () => {
    getCurrentSession.mockResolvedValue(session);
    findUserById.mockResolvedValue(null);
    await expect(requireActiveRole("ADMIN")).rejects.toThrow("REDIRECT:/login");
  });

  it("BLOQUEA un JWT ADMIN viejo de un usuario DESACTIVADO", async () => {
    getCurrentSession.mockResolvedValue(session);
    findUserById.mockResolvedValue({ ...dbUser, active: false });
    await expect(requireActiveRole("ADMIN")).rejects.toThrow("REDIRECT:/login");
  });

  it("BLOQUEA un usuario ARCHIVADO aunque archivedAt sea no-nulo", async () => {
    getCurrentSession.mockResolvedValue(session);
    findUserById.mockResolvedValue({
      ...dbUser,
      active: false,
      archivedAt: new Date("2026-06-10T22:00:00.000Z"),
    });
    await expect(requireActiveRole("ADMIN")).rejects.toThrow("REDIRECT:/login");
  });

  it("BLOQUEA un JWT ADMIN viejo de un usuario DEGRADADO (DB = OPERADOR)", async () => {
    getCurrentSession.mockResolvedValue(session);
    findUserById.mockResolvedValue({ ...dbUser, role: "OPERADOR" });
    await expect(requireActiveRole("ADMIN")).rejects.toThrow(
      "REDIRECT:/dashboard",
    );
  });

  it("permite un ADMIN activo y vigente en la base", async () => {
    getCurrentSession.mockResolvedValue(session);
    findUserById.mockResolvedValue(dbUser);

    const result = await requireActiveRole("ADMIN");

    expect(result.user.role).toBe("ADMIN");
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("requireCapability (DB-authoritative)", () => {
  const session = {
    user: { id: "u1", email: "op@x.com", name: "Op", role: "OPERADOR" as const },
  };
  const dbUser = {
    id: "u1",
    email: "op@x.com",
    name: "Op",
    role: "OPERADOR" as const,
    active: true,
    archivedAt: null,
    createdAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirige a /login si no hay sesión", async () => {
    getCurrentSession.mockResolvedValue(null);
    await expect(requireCapability("canViewReports")).rejects.toThrow(
      "REDIRECT:/login",
    );
  });

  it("redirige a /login si el usuario está DESACTIVADO", async () => {
    getCurrentSession.mockResolvedValue(session);
    findUserById.mockResolvedValue({ ...dbUser, active: false });
    await expect(requireCapability("canViewDashboard")).rejects.toThrow(
      "REDIRECT:/login",
    );
  });

  it("redirige a /login si el usuario está ARCHIVADO", async () => {
    getCurrentSession.mockResolvedValue(session);
    findUserById.mockResolvedValue({
      ...dbUser,
      active: false,
      archivedAt: new Date("2026-06-10T22:00:00.000Z"),
    });
    await expect(requireCapability("canViewDashboard")).rejects.toThrow(
      "REDIRECT:/login",
    );
  });

  it("redirige al home si el rol NO tiene la capability", async () => {
    getCurrentSession.mockResolvedValue(session);
    findUserById.mockResolvedValue(dbUser); // OPERADOR no ve reportes
    await expect(requireCapability("canViewReports")).rejects.toThrow(
      "REDIRECT:/dashboard",
    );
  });

  it("devuelve la sesión cuando el rol SÍ tiene la capability", async () => {
    getCurrentSession.mockResolvedValue(session);
    findUserById.mockResolvedValue(dbUser);

    const result = await requireCapability("canViewDashboard");

    expect(result.user.role).toBe("OPERADOR");
    expect(redirect).not.toHaveBeenCalled();
  });
});

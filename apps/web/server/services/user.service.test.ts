import { beforeEach, describe, expect, it, vi } from "vitest";

// Mockeamos prisma (no el repo) para ejercitar la transacción real del service
// + las funciones reales del repo, incluyendo el lock FOR UPDATE ($queryRaw).
const { prismaMock, hashPassword } = vi.hoisted(() => {
  const prismaMock = {
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { prismaMock, hashPassword: vi.fn() };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth/password", () => ({ hashPassword }));

import {
  createUser,
  setUserActive,
  updateUser,
  UserRuleError,
} from "./user.service";

const admin = {
  id: "admin-1",
  name: "Admin",
  email: "admin@x.com",
  role: "ADMIN" as const,
  active: true,
  createdAt: new Date(),
};
const operador = {
  ...admin,
  id: "op-1",
  role: "OPERADOR" as const,
  email: "op@x.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  // La transacción corre el callback con el mismo mock como tx.
  prismaMock.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prismaMock),
  );
  prismaMock.user.update.mockResolvedValue(operador);
});

describe("createUser", () => {
  it("hashea la contraseña y delega en el repositorio", async () => {
    hashPassword.mockResolvedValue("HASH");
    prismaMock.user.create.mockResolvedValue(operador);

    await createUser({
      name: "Op",
      email: "op@x.com",
      password: "secret-123",
      role: "OPERADOR",
    });

    expect(hashPassword).toHaveBeenCalledWith("secret-123");
    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          name: "Op",
          email: "op@x.com",
          passwordHash: "HASH",
          role: "OPERADOR",
        },
      }),
    );
  });
});

describe("updateUser · protección de rol (atómica)", () => {
  it("bloquea que un admin se degrade a sí mismo", async () => {
    prismaMock.user.findUnique.mockResolvedValue(admin);

    await expect(
      updateUser({
        id: "admin-1",
        actingUserId: "admin-1",
        input: { name: "Admin", email: "admin@x.com", role: "OPERADOR" },
      }),
    ).rejects.toMatchObject({ code: "SELF_ROLE_CHANGE" });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("bloquea degradar al último admin activo (con lock)", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...admin, id: "admin-2" });
    prismaMock.$queryRaw.mockResolvedValue([{ id: "admin-2" }]); // único admin

    await expect(
      updateUser({
        id: "admin-2",
        actingUserId: "admin-1",
        input: { name: "Admin", email: "a2@x.com", role: "OPERADOR" },
      }),
    ).rejects.toMatchObject({ code: "LAST_ADMIN" });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$queryRaw).toHaveBeenCalled(); // se tomó el lock
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("bloquea degradar al último administrador activo siendo SUPERADMIN", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      ...admin,
      id: "super-1",
      role: "SUPERADMIN",
    });
    prismaMock.$queryRaw.mockResolvedValue([{ id: "super-1" }]); // único admin

    await expect(
      updateUser({
        id: "super-1",
        actingUserId: "admin-1",
        input: { name: "Root", email: "root@x.com", role: "OPERADOR" },
      }),
    ).rejects.toMatchObject({ code: "LAST_ADMIN" });
    expect(prismaMock.$queryRaw).toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("permite degradar un admin cuando hay más de uno", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...admin, id: "admin-2" });
    prismaMock.$queryRaw.mockResolvedValue([{ id: "admin-1" }, { id: "admin-2" }]);

    await updateUser({
      id: "admin-2",
      actingUserId: "admin-1",
      input: { name: "Admin", email: "a2@x.com", role: "OPERADOR" },
    });

    expect(prismaMock.user.update).toHaveBeenCalled();
  });

  it("no toma el lock al pasar de ADMIN a SUPERADMIN (sigue siendo admin)", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...admin, id: "admin-2" });

    await updateUser({
      id: "admin-2",
      actingUserId: "admin-1",
      input: { name: "Admin", email: "a2@x.com", role: "SUPERADMIN" },
    });

    // No es degradación: ambos roles son administrativos → no se evalúa lockout.
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalled();
  });

  it("permite una edición normal sin tomar el lock", async () => {
    prismaMock.user.findUnique.mockResolvedValue(operador);

    await updateUser({
      id: "op-1",
      actingUserId: "admin-1",
      input: { name: "Op2", email: "op@x.com", role: "OPERADOR" },
    });

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it("hashea y persiste passwordHash cuando se edita la contraseña", async () => {
    prismaMock.user.findUnique.mockResolvedValue(operador);
    hashPassword.mockResolvedValue("NEW_HASH");

    await updateUser({
      id: "op-1",
      actingUserId: "admin-1",
      input: {
        name: "Op2",
        email: "op@x.com",
        role: "OPERADOR",
        password: "new-secret-123",
      },
    });

    expect(hashPassword).toHaveBeenCalledWith("new-secret-123");
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op-1" },
        data: {
          name: "Op2",
          email: "op@x.com",
          role: "OPERADOR",
          passwordHash: "NEW_HASH",
        },
      }),
    );
  });
});

describe("setUserActive · protección de cuenta (atómica)", () => {
  it("bloquea que un admin se desactive a sí mismo", async () => {
    prismaMock.user.findUnique.mockResolvedValue(admin);

    await expect(
      setUserActive({ id: "admin-1", actingUserId: "admin-1", active: false }),
    ).rejects.toMatchObject({ code: "SELF_DEACTIVATION" });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("bloquea desactivar al último admin activo (con lock)", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...admin, id: "admin-2" });
    prismaMock.$queryRaw.mockResolvedValue([{ id: "admin-2" }]);

    await expect(
      setUserActive({ id: "admin-2", actingUserId: "admin-1", active: false }),
    ).rejects.toMatchObject({ code: "LAST_ADMIN" });
    expect(prismaMock.$queryRaw).toHaveBeenCalled();
  });

  it("bloquea desactivar al último administrador activo siendo SUPERADMIN", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      ...admin,
      id: "super-1",
      role: "SUPERADMIN",
    });
    prismaMock.$queryRaw.mockResolvedValue([{ id: "super-1" }]);

    await expect(
      setUserActive({ id: "super-1", actingUserId: "admin-1", active: false }),
    ).rejects.toMatchObject({ code: "LAST_ADMIN" });
    expect(prismaMock.$queryRaw).toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("permite desactivar a un operador sin tomar el lock", async () => {
    prismaMock.user.findUnique.mockResolvedValue(operador);

    await setUserActive({ id: "op-1", actingUserId: "admin-1", active: false });

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "op-1" }, data: { active: false } }),
    );
  });

  it("reactiva sin chequear reglas de último admin", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...operador, active: false });

    await setUserActive({ id: "op-1", actingUserId: "admin-1", active: true });

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "op-1" }, data: { active: true } }),
    );
  });

  it("lanza NOT_FOUND si el usuario no existe", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(
      setUserActive({ id: "ghost", actingUserId: "admin-1", active: false }),
    ).rejects.toBeInstanceOf(UserRuleError);
  });
});

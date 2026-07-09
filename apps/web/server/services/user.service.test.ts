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
const supervisor = {
  ...admin,
  id: "sup-1",
  role: "SUPERVISOR" as const,
  email: "sup@x.com",
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
      actorRole: "ADMIN",
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

  it("un SUPERADMIN puede crear SUPERADMIN, ADMIN, SUPERVISOR y OPERADOR", async () => {
    hashPassword.mockResolvedValue("HASH");
    prismaMock.user.create.mockResolvedValue(operador);

    for (const role of ["SUPERADMIN", "ADMIN", "SUPERVISOR", "OPERADOR"] as const) {
      await expect(
        createUser({
          name: "X",
          email: "x@x.com",
          password: "secret-123",
          role,
          actorRole: "SUPERADMIN",
        }),
      ).resolves.toBeDefined();
    }
    expect(prismaMock.user.create).toHaveBeenCalledTimes(4);
  });

  it("un ADMIN puede crear ADMIN, SUPERVISOR y OPERADOR (su propia tier y abajo)", async () => {
    hashPassword.mockResolvedValue("HASH");
    prismaMock.user.create.mockResolvedValue(operador);

    for (const role of ["ADMIN", "SUPERVISOR", "OPERADOR"] as const) {
      await expect(
        createUser({
          name: "X",
          email: "x@x.com",
          password: "secret-123",
          role,
          actorRole: "ADMIN",
        }),
      ).resolves.toBeDefined();
    }
    expect(prismaMock.user.create).toHaveBeenCalledTimes(3);
  });

  it("un SUPERVISOR NO puede crear usuarios", async () => {
    hashPassword.mockResolvedValue("HASH");

    await expect(
      createUser({
        name: "Op",
        email: "op@x.com",
        password: "secret-123",
        role: "OPERADOR",
        actorRole: "SUPERVISOR",
      }),
    ).rejects.toMatchObject({ code: "ROLE_NOT_ASSIGNABLE" });

    expect(hashPassword).not.toHaveBeenCalled();
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it("un ADMIN NO puede crear un SUPERADMIN y falla antes de escribir", async () => {
    hashPassword.mockResolvedValue("HASH");

    await expect(
      createUser({
        name: "Root",
        email: "root@x.com",
        password: "secret-123",
        role: "SUPERADMIN",
        actorRole: "ADMIN",
      }),
    ).rejects.toMatchObject({ code: "ROLE_NOT_ASSIGNABLE" });

    // Falla antes de hashear y antes de tocar el repositorio.
    expect(hashPassword).not.toHaveBeenCalled();
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });
});

describe("updateUser · protección de rol (atómica)", () => {
  it("bloquea que un admin se degrade a sí mismo", async () => {
    prismaMock.user.findUnique.mockResolvedValue(admin);

    await expect(
      updateUser({
        id: "admin-1",
        actingUserId: "admin-1",
        actorRole: "ADMIN",
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
        actorRole: "ADMIN",
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
        actorRole: "SUPERADMIN",
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
      actorRole: "ADMIN",
      input: { name: "Admin", email: "a2@x.com", role: "OPERADOR" },
    });

    expect(prismaMock.user.update).toHaveBeenCalled();
  });

  it("no toma el lock al pasar de ADMIN a SUPERADMIN (sigue siendo admin)", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...admin, id: "admin-2" });

    await updateUser({
      id: "admin-2",
      actingUserId: "admin-1",
      actorRole: "SUPERADMIN",
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
      actorRole: "ADMIN",
      input: { name: "Op2", email: "op@x.com", role: "OPERADOR" },
    });

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it("permite que un ADMIN edite a un SUPERVISOR sin tomar el lock anti-lockout", async () => {
    prismaMock.user.findUnique.mockResolvedValue(supervisor);

    await updateUser({
      id: "sup-1",
      actingUserId: "admin-1",
      actorRole: "ADMIN",
      input: { name: "Sup2", email: "sup2@x.com", role: "SUPERVISOR" },
    });

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sup-1" },
        data: { name: "Sup2", email: "sup2@x.com", role: "SUPERVISOR" },
      }),
    );
  });

  it("permite que un ADMIN edite a otro ADMIN sin cambiar contraseña", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...admin, id: "admin-2" });

    await updateUser({
      id: "admin-2",
      actingUserId: "admin-1",
      actorRole: "ADMIN",
      input: { name: "Admin 2", email: "a2@x.com", role: "ADMIN" },
    });

    expect(hashPassword).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "admin-2" },
        data: { name: "Admin 2", email: "a2@x.com", role: "ADMIN" },
      }),
    );
  });

  it("bloquea que un ADMIN cambie la contraseña de otro ADMIN", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...admin, id: "admin-2" });

    await expect(
      updateUser({
        id: "admin-2",
        actingUserId: "admin-1",
        actorRole: "ADMIN",
        input: {
          name: "Admin 2",
          email: "a2@x.com",
          role: "ADMIN",
          password: "new-secret-123",
        },
      }),
    ).rejects.toMatchObject({ code: "PASSWORD_RESET_NOT_ALLOWED" });
    expect(hashPassword).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("permite que un ADMIN cambie su propia contraseña", async () => {
    prismaMock.user.findUnique.mockResolvedValue(admin);
    hashPassword.mockResolvedValue("SELF_HASH");

    await updateUser({
      id: "admin-1",
      actingUserId: "admin-1",
      actorRole: "ADMIN",
      input: {
        name: "Admin",
        email: "admin@x.com",
        role: "ADMIN",
        password: "new-secret-123",
      },
    });

    expect(hashPassword).toHaveBeenCalledWith("new-secret-123");
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "admin-1" },
        data: expect.objectContaining({ passwordHash: "SELF_HASH" }),
      }),
    );
  });

  it("hashea y persiste passwordHash cuando se edita la contraseña", async () => {
    prismaMock.user.findUnique.mockResolvedValue(operador);
    hashPassword.mockResolvedValue("NEW_HASH");

    await updateUser({
      id: "op-1",
      actingUserId: "admin-1",
      actorRole: "ADMIN",
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

  it("permite que SUPERADMIN cambie la contraseña de un ADMIN", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...admin, id: "admin-2" });
    hashPassword.mockResolvedValue("ADMIN_HASH");

    await updateUser({
      id: "admin-2",
      actingUserId: "super-1",
      actorRole: "SUPERADMIN",
      input: {
        name: "Admin 2",
        email: "a2@x.com",
        role: "ADMIN",
        password: "new-secret-123",
      },
    });

    expect(hashPassword).toHaveBeenCalledWith("new-secret-123");
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "admin-2" },
        data: expect.objectContaining({ passwordHash: "ADMIN_HASH" }),
      }),
    );
  });
});

describe("setUserActive · protección de cuenta (atómica)", () => {
  it("un ADMIN que se desactiva a sí mismo ve SELF_DEACTIVATION, no el techo", async () => {
    // Prueba el ORDEN: el autobloqueo dispara antes que el techo, dando el mensaje
    // específico (SELF_DEACTIVATION) en vez del genérico.
    prismaMock.user.findUnique.mockResolvedValue(admin);

    await expect(
      setUserActive({
        id: "admin-1",
        actingUserId: "admin-1",
        actorRole: "ADMIN",
        active: false,
      }),
    ).rejects.toMatchObject({ code: "SELF_DEACTIVATION" });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("bloquea desactivar al último admin activo (con lock)", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...admin, id: "admin-2" });
    prismaMock.$queryRaw.mockResolvedValue([{ id: "admin-2" }]);

    await expect(
      setUserActive({
        id: "admin-2",
        actingUserId: "admin-1",
        actorRole: "ADMIN",
        active: false,
      }),
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
      setUserActive({
        id: "super-1",
        actingUserId: "admin-1",
        actorRole: "SUPERADMIN",
        active: false,
      }),
    ).rejects.toMatchObject({ code: "LAST_ADMIN" });
    expect(prismaMock.$queryRaw).toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("permite desactivar a un operador sin tomar el lock", async () => {
    prismaMock.user.findUnique.mockResolvedValue(operador);

    await setUserActive({
      id: "op-1",
      actingUserId: "admin-1",
      actorRole: "ADMIN",
      active: false,
    });

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "op-1" }, data: { active: false } }),
    );
  });

  it("permite desactivar a un SUPERVISOR sin contarlo como LAST_ADMIN", async () => {
    prismaMock.user.findUnique.mockResolvedValue(supervisor);

    await setUserActive({
      id: "sup-1",
      actingUserId: "admin-1",
      actorRole: "ADMIN",
      active: false,
    });

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sup-1" }, data: { active: false } }),
    );
  });

  it("reactiva sin chequear reglas de último admin", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...operador, active: false });

    await setUserActive({
      id: "op-1",
      actingUserId: "admin-1",
      actorRole: "ADMIN",
      active: true,
    });

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "op-1" }, data: { active: true } }),
    );
  });

  it("lanza NOT_FOUND si el usuario no existe", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(
      setUserActive({
        id: "ghost",
        actingUserId: "admin-1",
        actorRole: "ADMIN",
        active: false,
      }),
    ).rejects.toBeInstanceOf(UserRuleError);
  });
});

const superadmin = {
  ...admin,
  id: "super-1",
  role: "SUPERADMIN" as const,
  email: "super@x.com",
};

describe("techo por rango (anti-escalada por proxy)", () => {
  it("un ADMIN NO puede editar a un SUPERADMIN (TARGET_OUTRANKS_ACTOR)", async () => {
    prismaMock.user.findUnique.mockResolvedValue(superadmin);

    await expect(
      updateUser({
        id: "super-1",
        actingUserId: "admin-1",
        actorRole: "ADMIN",
        input: { name: "Root", email: "super@x.com", role: "SUPERADMIN" },
      }),
    ).rejects.toMatchObject({ code: "TARGET_OUTRANKS_ACTOR" });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("un ADMIN NO puede asignar el rol SUPERADMIN en updateUser (ROLE_NOT_ASSIGNABLE)", async () => {
    prismaMock.user.findUnique.mockResolvedValue(operador);

    await expect(
      updateUser({
        id: "op-1",
        actingUserId: "admin-1",
        actorRole: "ADMIN",
        input: { name: "Op", email: "op@x.com", role: "SUPERADMIN" },
      }),
    ).rejects.toMatchObject({ code: "ROLE_NOT_ASSIGNABLE" });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("un OPERADOR NO puede editar usuarios", async () => {
    prismaMock.user.findUnique.mockResolvedValue(operador);

    await expect(
      updateUser({
        id: "op-1",
        actingUserId: "operator-2",
        actorRole: "OPERADOR",
        input: { name: "Op", email: "op@x.com", role: "OPERADOR" },
      }),
    ).rejects.toMatchObject({ code: "TARGET_OUTRANKS_ACTOR" });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("un SUPERVISOR NO puede editar usuarios", async () => {
    prismaMock.user.findUnique.mockResolvedValue(operador);

    await expect(
      updateUser({
        id: "op-1",
        actingUserId: "sup-1",
        actorRole: "SUPERVISOR",
        input: { name: "Op", email: "op@x.com", role: "OPERADOR" },
      }),
    ).rejects.toMatchObject({ code: "TARGET_OUTRANKS_ACTOR" });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("un ADMIN NO puede desactivar a un SUPERADMIN (TARGET_OUTRANKS_ACTOR)", async () => {
    prismaMock.user.findUnique.mockResolvedValue(superadmin);

    await expect(
      setUserActive({
        id: "super-1",
        actingUserId: "admin-1",
        actorRole: "ADMIN",
        active: false,
      }),
    ).rejects.toMatchObject({ code: "TARGET_OUTRANKS_ACTOR" });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("un ADMIN SÍ puede desactivar a otro ADMIN (misma tier), si no es el último", async () => {
    // Regla nueva: un ADMIN gestiona su propia tier. La desactivación pasa el
    // techo y solo la frena LAST_ADMIN si fuera el último administrador activo.
    prismaMock.user.findUnique.mockResolvedValue({ ...admin, id: "admin-2" });
    prismaMock.$queryRaw.mockResolvedValue([{ id: "admin-1" }, { id: "admin-2" }]);

    await setUserActive({
      id: "admin-2",
      actingUserId: "admin-1",
      actorRole: "ADMIN",
      active: false,
    });

    expect(prismaMock.$queryRaw).toHaveBeenCalled(); // se tomó el lock anti-lockout
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "admin-2" }, data: { active: false } }),
    );
  });
});

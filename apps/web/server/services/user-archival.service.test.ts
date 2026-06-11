import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock de Prisma — ejercita la lógica transaccional del servicio sin DB.
// ---------------------------------------------------------------------------

const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    user: { findUnique: vi.fn(), update: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { prismaMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import {
  archiveUser,
  unarchiveUser,
  UserRuleError,
} from "./user.service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-10T22:00:00.000Z");

const superAdmin = {
  id: "sa-1",
  name: "Super Admin",
  email: "super@x.com",
  role: "SUPERADMIN" as const,
  active: true,
  archivedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const operador = {
  id: "op-1",
  name: "Operador",
  email: "op@x.com",
  role: "OPERADOR" as const,
  active: true,
  archivedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const archivedUser = {
  ...operador,
  id: "op-arch",
  active: false,
  archivedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  // La transacción pasa el mismo mock como cliente de tx
  prismaMock.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prismaMock),
  );
  prismaMock.user.update.mockResolvedValue({ ...operador, active: false, archivedAt: NOW });
});

// ---------------------------------------------------------------------------
// archiveUser — guards
// ---------------------------------------------------------------------------

describe("archiveUser · NOT_FOUND", () => {
  it("throws NOT_FOUND when user does not exist", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(
      archiveUser({ id: "ghost", actingUserId: "sa-1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

describe("archiveUser · SELF_ARCHIVE", () => {
  it("blocks archiving your own account", async () => {
    prismaMock.user.findUnique.mockResolvedValue(superAdmin);

    await expect(
      archiveUser({ id: "sa-1", actingUserId: "sa-1" }),
    ).rejects.toMatchObject({ code: "SELF_ARCHIVE" });

    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

describe("archiveUser · ALREADY_ARCHIVED", () => {
  it("blocks re-archiving an already archived user", async () => {
    prismaMock.user.findUnique.mockResolvedValue(archivedUser);

    await expect(
      archiveUser({ id: "op-arch", actingUserId: "sa-1" }),
    ).rejects.toMatchObject({ code: "ALREADY_ARCHIVED" });

    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

describe("archiveUser · LAST_ADMIN", () => {
  it("blocks archiving the last active admin (acquires lock)", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...superAdmin, id: "sa-2" });
    // Only one active admin in lock
    prismaMock.$queryRaw.mockResolvedValue([{ id: "sa-2" }]);

    await expect(
      archiveUser({ id: "sa-2", actingUserId: "sa-1" }),
    ).rejects.toMatchObject({ code: "LAST_ADMIN" });

    expect(prismaMock.$queryRaw).toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("allows archiving an admin when more than one active admin exists", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...superAdmin, id: "sa-2" });
    // Two active admins
    prismaMock.$queryRaw.mockResolvedValue([{ id: "sa-1" }, { id: "sa-2" }]);

    await archiveUser({ id: "sa-2", actingUserId: "sa-1" });

    expect(prismaMock.user.update).toHaveBeenCalled();
  });

  it("does NOT acquire lock when archiving a non-admin user", async () => {
    prismaMock.user.findUnique.mockResolvedValue(operador);

    await archiveUser({ id: "op-1", actingUserId: "sa-1" });

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalled();
  });
});

describe("archiveUser · happy path", () => {
  it("runs inside a $transaction", async () => {
    prismaMock.user.findUnique.mockResolvedValue(operador);

    await archiveUser({ id: "op-1", actingUserId: "sa-1" });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("calls update with archivedAt AND active=false", async () => {
    prismaMock.user.findUnique.mockResolvedValue(operador);

    await archiveUser({ id: "op-1", actingUserId: "sa-1" });

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op-1" },
        data: expect.objectContaining({ active: false }),
      }),
    );
    // archivedAt must be a Date (not null)
    const data = prismaMock.user.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.archivedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// unarchiveUser — guards
// ---------------------------------------------------------------------------

describe("unarchiveUser · NOT_FOUND", () => {
  it("throws NOT_FOUND when user does not exist", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(
      unarchiveUser({ id: "ghost" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

describe("unarchiveUser · NOT_ARCHIVED", () => {
  it("throws NOT_ARCHIVED when user is not archived", async () => {
    prismaMock.user.findUnique.mockResolvedValue(operador); // archivedAt: null

    await expect(
      unarchiveUser({ id: "op-1" }),
    ).rejects.toMatchObject({ code: "NOT_ARCHIVED" });

    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

describe("unarchiveUser · happy path", () => {
  it("clears archivedAt (sets null) without changing active", async () => {
    prismaMock.user.findUnique.mockResolvedValue(archivedUser);
    prismaMock.user.update.mockResolvedValue({
      ...archivedUser,
      archivedAt: null,
      // active remains false — restore does NOT reactivate
      active: false,
    });

    const result = await unarchiveUser({ id: "op-arch" });

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op-arch" },
        data: expect.objectContaining({ archivedAt: null }),
      }),
    );
    // update data must NOT include active
    const data = prismaMock.user.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("active");
    expect(result.archivedAt).toBeNull();
  });

  it("does NOT need a lock (no last-admin check needed for restore)", async () => {
    prismaMock.user.findUnique.mockResolvedValue(archivedUser);
    prismaMock.user.update.mockResolvedValue({ ...archivedUser, archivedAt: null });

    await unarchiveUser({ id: "op-arch" });

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });
});

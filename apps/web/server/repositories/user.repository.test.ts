import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock de Prisma — ejercita las funciones reales del repositorio con prisma
// simulado (sin base de datos).
// ---------------------------------------------------------------------------

const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };
  return { prismaMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import {
  archiveUser,
  listUsers,
  unarchiveUser,
} from "./user.repository";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-10T22:00:00.000Z");

const activeUser = {
  id: "user-1",
  name: "Usuario Activo",
  email: "activo@x.com",
  role: "OPERADOR" as const,
  active: true,
  archivedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const archivedUser = {
  ...activeUser,
  id: "user-2",
  active: false,
  archivedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.user.findMany.mockResolvedValue([]);
  prismaMock.user.findUnique.mockResolvedValue(null);
  prismaMock.user.update.mockResolvedValue(activeUser);
});

// ---------------------------------------------------------------------------
// archiveUser
// ---------------------------------------------------------------------------

describe("archiveUser", () => {
  it("sets archivedAt AND active=false atomically", async () => {
    prismaMock.user.update.mockResolvedValue({
      ...activeUser,
      active: false,
      archivedAt: NOW,
    });

    const result = await archiveUser(prismaMock as never, "user-1", NOW);

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: { archivedAt: NOW, active: false },
      }),
    );
    expect(result.archivedAt).toEqual(NOW);
    expect(result.active).toBe(false);
  });

  it("uses the provided tx client (not the singleton)", async () => {
    const txMock = { user: { update: vi.fn().mockResolvedValue({ ...activeUser, archivedAt: NOW, active: false }) } };

    await archiveUser(txMock as never, "user-1", NOW);

    expect(txMock.user.update).toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// unarchiveUser
// ---------------------------------------------------------------------------

describe("unarchiveUser", () => {
  it("clears archivedAt (sets null) WITHOUT changing active", async () => {
    prismaMock.user.update.mockResolvedValue({
      ...archivedUser,
      archivedAt: null,
      // active stays false — restore does NOT reactivate
      active: false,
    });

    const result = await unarchiveUser(prismaMock as never, "user-2");

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-2" },
        data: { archivedAt: null },
      }),
    );
    // The update data must NOT include active — restore leaves active as-is
    const callData = prismaMock.user.update.mock.calls[0]![0].data;
    expect(callData).not.toHaveProperty("active");
    expect(result.archivedAt).toBeNull();
  });

  it("uses the provided tx client (not the singleton)", async () => {
    const txMock = { user: { update: vi.fn().mockResolvedValue({ ...archivedUser, archivedAt: null }) } };

    await unarchiveUser(txMock as never, "user-2");

    expect(txMock.user.update).toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listUsers — includeArchived flag
// ---------------------------------------------------------------------------

describe("listUsers · includeArchived", () => {
  it("excludes archived users by default (archivedAt: null filter)", async () => {
    prismaMock.user.findMany.mockResolvedValue([activeUser]);

    await listUsers({});

    const args = prismaMock.user.findMany.mock.calls[0]![0];
    expect(args.where).toEqual(expect.objectContaining({ archivedAt: null }));
  });

  it("excludes archived users when includeArchived=false", async () => {
    prismaMock.user.findMany.mockResolvedValue([activeUser]);

    await listUsers({ includeArchived: false });

    const args = prismaMock.user.findMany.mock.calls[0]![0];
    expect(args.where).toEqual(expect.objectContaining({ archivedAt: null }));
  });

  it("returns all users (no archivedAt filter) when includeArchived=true", async () => {
    prismaMock.user.findMany.mockResolvedValue([activeUser, archivedUser]);

    await listUsers({ includeArchived: true });

    const args = prismaMock.user.findMany.mock.calls[0]![0];
    // when includeArchived=true, where should be undefined OR not contain archivedAt
    const where = args.where as Record<string, unknown> | undefined;
    const hasArchivedAtFilter = where !== undefined && "archivedAt" in where;
    expect(hasArchivedAtFilter).toBe(false);
  });

  it("includes archivedAt in returned UserListItem", async () => {
    prismaMock.user.findMany.mockResolvedValue([archivedUser]);

    const result = await listUsers({ includeArchived: true });

    expect(result.items[0]).toHaveProperty("archivedAt");
  });
});

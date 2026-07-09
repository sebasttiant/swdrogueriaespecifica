import { beforeEach, describe, expect, it, vi } from "vitest";

const ROLES = {
  ADMIN: "ADMIN",
  SUPERADMIN: "SUPERADMIN",
} as const;

const {
  auditContextFromHeaders,
  createUser,
  KnownRequestError,
  recordAudit,
  requireActiveRole,
  revalidatePath,
  safeParse,
  setUserActive,
  updateUser,
  UserRuleError,
  archiveUser,
  unarchiveUser,
} = vi.hoisted(() => {
  class MockKnownRequestError extends Error {
    code = "";
    meta?: { target?: string | string[] };
  }

  class MockUserRuleError extends Error {
    constructor(public readonly code: string) {
      super(code);
      this.name = "UserRuleError";
    }
  }

  return {
    archiveUser: vi.fn(),
    auditContextFromHeaders: vi.fn(),
    createUser: vi.fn(),
    KnownRequestError: MockKnownRequestError,
    recordAudit: vi.fn(),
    requireActiveRole: vi.fn(),
    revalidatePath: vi.fn(),
    safeParse: vi.fn(),
    setUserActive: vi.fn(),
    unarchiveUser: vi.fn(),
    updateUser: vi.fn(),
    UserRuleError: MockUserRuleError,
  };
});

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/auth/require-role", () => ({ requireActiveRole }));
vi.mock("@/lib/generated/prisma/client", () => ({
  Prisma: { PrismaClientKnownRequestError: KnownRequestError },
}));
vi.mock("@/server/services/audit.service", () => ({
  auditContextFromHeaders,
  recordAudit,
}));
vi.mock("@/server/services/user.service", () => ({
  archiveUser,
  createUser,
  setUserActive,
  unarchiveUser,
  updateUser,
  UserRuleError,
}));
vi.mock("@/features/admin/schema", () => ({
  userCreateSchema: { safeParse: vi.fn() },
  userUpdateSchema: { safeParse },
}));

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { updateUserAction } from "./user.actions";

const PREV = { error: null, ok: false };

function updateFormData(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("id", "target-1");
  data.set("name", "Target User");
  data.set("email", "target@example.com");
  data.set("role", "ADMIN");

  for (const [key, value] of Object.entries(overrides)) {
    data.set(key, value);
  }

  return data;
}

function parsedUpdate(overrides = {}) {
  return {
    name: "Target User",
    email: "target@example.com",
    role: "ADMIN",
    ...overrides,
  };
}

function updatedUserResult(overrides = {}) {
  return {
    before: {
      id: "target-1",
      name: "Old Target",
      email: "old@example.com",
      role: "ADMIN",
      active: true,
      archivedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      passwordHash: "old-hash",
    },
    after: {
      id: "target-1",
      name: "Target User",
      email: "target@example.com",
      role: "ADMIN",
      active: true,
      archivedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      password: "raw-secret",
      passwordHash: "new-hash",
    },
    passwordUpdated: false,
    ...overrides,
  };
}

function duplicateEmailError() {
  return Object.assign(new KnownRequestError("duplicate email"), {
    code: "P2002",
    meta: { target: ["email"] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auditContextFromHeaders.mockResolvedValue({
    userId: "actor-1",
    channel: "web",
  });
  safeParse.mockReturnValue({ success: true, data: parsedUpdate() });
  updateUser.mockResolvedValue(updatedUserResult());
});

describe("updateUserAction", () => {
  it.each([ROLES.ADMIN, ROLES.SUPERADMIN])(
    "allows %s at the action boundary and passes actor identity to the service",
    async (role) => {
      requireActiveRole.mockResolvedValue({
        user: { id: "actor-1", email: "actor@example.com", name: "Actor", role },
      });

      await expect(updateUserAction(PREV, updateFormData())).resolves.toEqual({
        error: null,
        ok: true,
      });

      expect(requireActiveRole).toHaveBeenCalledWith("SUPERADMIN", "ADMIN");
      expect(updateUser).toHaveBeenCalledWith({
        id: "target-1",
        actingUserId: "actor-1",
        actorRole: role,
        input: parsedUpdate(),
      });
    },
  );

  it("maps known rule and duplicate email errors to safe user-facing messages", async () => {
    requireActiveRole.mockResolvedValue({
      user: {
        id: "actor-1",
        email: "actor@example.com",
        name: "Actor",
        role: ROLES.ADMIN,
      },
    });

    updateUser.mockRejectedValueOnce(
      new UserRuleError("PASSWORD_RESET_NOT_ALLOWED"),
    );
    await expect(updateUserAction(PREV, updateFormData())).resolves.toEqual({
      error: "No podés cambiar la contraseña de otro administrador.",
      ok: false,
    });

    updateUser.mockRejectedValueOnce(duplicateEmailError());
    await expect(updateUserAction(PREV, updateFormData())).resolves.toEqual({
      error: "Ya existe un usuario con ese email.",
      ok: false,
    });

    expect(recordAudit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("audits USER_UPDATE with safe before and after fields and revalidates admin views", async () => {
    requireActiveRole.mockResolvedValue({
      user: {
        id: "actor-1",
        email: "actor@example.com",
        name: "Actor",
        role: ROLES.ADMIN,
      },
    });

    await expect(updateUserAction(PREV, updateFormData())).resolves.toEqual({
      error: null,
      ok: true,
    });

    expect(recordAudit).toHaveBeenCalledWith({
      action: AUDIT_ACTIONS.USER_UPDATE,
      module: AUDIT_MODULES.USUARIOS,
      entity: "User",
      entityId: "target-1",
      before: {
        name: "Old Target",
        email: "old@example.com",
        role: "ADMIN",
        active: true,
      },
      after: {
        name: "Target User",
        email: "target@example.com",
        role: "ADMIN",
        active: true,
      },
      context: { userId: "actor-1", channel: "web" },
    });
    expect(JSON.stringify(recordAudit.mock.calls[0]?.[0])).not.toMatch(
      /password|hash/i,
    );
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/target-1");
  });

  it("audits password changes with only the safe passwordUpdated marker", async () => {
    requireActiveRole.mockResolvedValue({
      user: {
        id: "super-1",
        email: "super@example.com",
        name: "Super",
        role: ROLES.SUPERADMIN,
      },
    });
    safeParse.mockReturnValue({
      success: true,
      data: parsedUpdate({ password: "new-secret" }),
    });
    updateUser.mockResolvedValue(
      updatedUserResult({ passwordUpdated: true }),
    );

    await expect(
      updateUserAction(PREV, updateFormData({ password: "new-secret" })),
    ).resolves.toEqual({ error: null, ok: true });

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({ passwordUpdated: true }),
      }),
    );
    const auditPayload = JSON.stringify(recordAudit.mock.calls[0]?.[0]);
    expect(auditPayload).toContain("passwordUpdated");
    expect(auditPayload).not.toContain("new-secret");
    expect(auditPayload).not.toContain("old-hash");
    expect(auditPayload).not.toContain("new-hash");
  });
});

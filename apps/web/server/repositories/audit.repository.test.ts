import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    auditLog: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  };
  return { prismaMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { encodeCursor } from "@/lib/pagination";
import { listAuditLogs } from "./audit.repository";

// Minimal valid AuditLogListItem row.
function makeRow(
  overrides: Partial<{
    id: string;
    action: string;
    module: string;
    result: "SUCCESS" | "FAILURE";
  }> = {},
) {
  return {
    id: overrides.id ?? "log-1",
    action: overrides.action ?? "auth.login",
    module: overrides.module ?? "auth",
    entity: "User",
    entityId: null,
    result: overrides.result ?? "SUCCESS",
    createdAt: new Date("2026-06-10T12:00:00.000Z"),
    user: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.auditLog.findUnique.mockResolvedValue(null);
  prismaMock.auditLog.findMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Seguridad del cursor (tests previos — no se modifican)
// ---------------------------------------------------------------------------

describe("listAuditLogs · seguridad del cursor", () => {
  it("ignora un cursor malformado y sirve la primera página", async () => {
    await listAuditLogs({ cursor: "###no-es-base64###" });

    expect(prismaMock.auditLog.findUnique).not.toHaveBeenCalled();
    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it("ignora un cursor bien formado pero inexistente (primera página)", async () => {
    prismaMock.auditLog.findUnique.mockResolvedValue(null);

    await listAuditLogs({ cursor: encodeCursor("fantasma-9999") });

    expect(prismaMock.auditLog.findUnique).toHaveBeenCalledWith({
      where: { id: "fantasma-9999" },
      select: { id: true },
    });
    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it("pagina normalmente con un cursor válido y existente", async () => {
    prismaMock.auditLog.findUnique.mockResolvedValue({ id: "real-id" });

    await listAuditLogs({ cursor: encodeCursor("real-id") });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.cursor).toEqual({ id: "real-id" });
    expect(args.skip).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// No filters — baseline
// ---------------------------------------------------------------------------

describe("listAuditLogs · no filters", () => {
  it("calls findMany with no where clause when no filters provided", async () => {
    await listAuditLogs({});

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });

  it("preserves cursor pagination when no filters provided", async () => {
    const cursorId = "log-abc";
    prismaMock.auditLog.findUnique.mockResolvedValueOnce({ id: cursorId });
    prismaMock.auditLog.findMany.mockResolvedValueOnce([makeRow({ id: cursorId })]);

    await listAuditLogs({ cursor: encodeCursor(cursorId) });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.cursor).toEqual({ id: cursorId });
    expect(args.skip).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// action filter
// ---------------------------------------------------------------------------

describe("listAuditLogs · action filter", () => {
  it("passes exact action match when action filter provided", async () => {
    await listAuditLogs({ action: "auth.login" });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({ action: "auth.login" });
  });

  it("does NOT add action filter when action is undefined", async () => {
    await listAuditLogs({ action: undefined });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });

  it("does NOT add action filter when action is empty string", async () => {
    await listAuditLogs({ action: "" });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// module filter
// ---------------------------------------------------------------------------

describe("listAuditLogs · module filter", () => {
  it("passes exact module match when module filter provided", async () => {
    await listAuditLogs({ module: "auth" });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({ module: "auth" });
  });

  it("does NOT add module filter when module is undefined", async () => {
    await listAuditLogs({ module: undefined });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// result filter
// ---------------------------------------------------------------------------

describe("listAuditLogs · result filter", () => {
  it("passes exact result match for SUCCESS", async () => {
    await listAuditLogs({ result: "SUCCESS" });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({ result: "SUCCESS" });
  });

  it("passes exact result match for FAILURE", async () => {
    await listAuditLogs({ result: "FAILURE" });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({ result: "FAILURE" });
  });

  it("does NOT add result filter when result is undefined", async () => {
    await listAuditLogs({ result: undefined });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// userText filter (free-text search on user name/email via JOIN)
// ---------------------------------------------------------------------------

describe("listAuditLogs · userText filter", () => {
  it("passes OR user name+email contains clause for free-text search", async () => {
    await listAuditLogs({ userText: "ana" });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({
      user: {
        OR: [
          { name: { contains: "ana", mode: "insensitive" } },
          { email: { contains: "ana", mode: "insensitive" } },
        ],
      },
    });
  });

  it("does NOT add user filter when userText is undefined", async () => {
    await listAuditLogs({ userText: undefined });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });

  it("does NOT add user filter when userText is empty string", async () => {
    await listAuditLogs({ userText: "" });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });

  it("does NOT add user filter when userText is whitespace-only", async () => {
    await listAuditLogs({ userText: "   " });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// date range filter (from / to as YYYY-MM-DD strings)
// ---------------------------------------------------------------------------

describe("listAuditLogs · date range filter", () => {
  it("passes createdAt gte when 'from' filter provided", async () => {
    await listAuditLogs({ from: "2026-06-10" });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    // 2026-06-10 00:00:00 COT = 2026-06-10T05:00:00.000Z
    expect(args.where).toEqual({
      createdAt: { gte: new Date("2026-06-10T05:00:00.000Z") },
    });
  });

  it("passes createdAt lt when 'to' filter provided (exclusive next-day)", async () => {
    await listAuditLogs({ to: "2026-06-10" });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    // Exclusive: 2026-06-11 00:00:00 COT = 2026-06-11T05:00:00.000Z
    expect(args.where).toEqual({
      createdAt: { lt: new Date("2026-06-11T05:00:00.000Z") },
    });
  });

  it("passes createdAt gte+lt when both 'from' and 'to' provided", async () => {
    await listAuditLogs({ from: "2026-06-01", to: "2026-06-10" });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({
      createdAt: {
        gte: new Date("2026-06-01T05:00:00.000Z"),
        lt: new Date("2026-06-11T05:00:00.000Z"),
      },
    });
  });

  it("does NOT add createdAt filter when both from and to are undefined", async () => {
    await listAuditLogs({ from: undefined, to: undefined });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });

  it("does NOT add createdAt filter when both from and to are empty strings", async () => {
    await listAuditLogs({ from: "", to: "" });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// combined filters (AND semantics)
// ---------------------------------------------------------------------------

describe("listAuditLogs · combined filters", () => {
  it("combines action + module + result into a single where object", async () => {
    await listAuditLogs({
      action: "auth.login.failed",
      module: "auth",
      result: "FAILURE",
    });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({
      action: "auth.login.failed",
      module: "auth",
      result: "FAILURE",
    });
  });

  it("combines date range + userText + action into a single where object", async () => {
    await listAuditLogs({
      from: "2026-06-01",
      to: "2026-06-30",
      userText: "ana",
      action: "auth.login",
    });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({
      action: "auth.login",
      createdAt: {
        gte: new Date("2026-06-01T05:00:00.000Z"),
        lt: new Date("2026-07-01T05:00:00.000Z"),
      },
      user: {
        OR: [
          { name: { contains: "ana", mode: "insensitive" } },
          { email: { contains: "ana", mode: "insensitive" } },
        ],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// cursor pagination preserved with filters active
// ---------------------------------------------------------------------------

describe("listAuditLogs · cursor pagination with filters", () => {
  it("cursor + skip still set when filters are active", async () => {
    const cursorId = "log-xyz";
    prismaMock.auditLog.findUnique.mockResolvedValueOnce({ id: cursorId });
    prismaMock.auditLog.findMany.mockResolvedValueOnce([makeRow({ id: cursorId })]);

    await listAuditLogs({
      cursor: encodeCursor(cursorId),
      action: "auth.login",
      module: "auth",
    });

    const args = prismaMock.auditLog.findMany.mock.calls[0]![0];
    expect(args.cursor).toEqual({ id: cursorId });
    expect(args.skip).toBe(1);
    expect(args.where).toEqual({ action: "auth.login", module: "auth" });
  });

  it("returns nextCursor when more items exist with filters active", async () => {
    const rows = Array.from({ length: 21 }, (_, i) =>
      makeRow({ id: `log-${i}` }),
    );
    prismaMock.auditLog.findMany.mockResolvedValueOnce(rows);

    const result = await listAuditLogs({ action: "auth.login", take: 20 });

    expect(result.items).toHaveLength(20);
    expect(result.nextCursor).not.toBeNull();
  });

  it("returns null nextCursor when no more items with filters active", async () => {
    prismaMock.auditLog.findMany.mockResolvedValueOnce([makeRow()]);

    const result = await listAuditLogs({ module: "auth", take: 20 });

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });
});

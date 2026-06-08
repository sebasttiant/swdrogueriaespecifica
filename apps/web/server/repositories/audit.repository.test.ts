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

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.auditLog.findMany.mockResolvedValue([]);
});

// El cursor es input controlado por el usuario (?cursor=...): nunca debe
// romper la consulta ni filtrarse a Prisma si apunta a un id inexistente.
describe("listAuditLogs · seguridad del cursor", () => {
  it("ignora un cursor malformado y sirve la primera página", async () => {
    await listAuditLogs({ cursor: "###no-es-base64###" });

    // decodeCursor descarta la basura antes de llegar a la base.
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

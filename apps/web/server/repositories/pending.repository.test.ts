import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    pending: {
      count: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  };
  return { prismaMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { encodeCursor } from "@/lib/pagination";
import { listPendings, countUpcomingPendings } from "./pending.repository";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.pending.findMany.mockResolvedValue([]);
  prismaMock.pending.count.mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// countUpcomingPendings — 24h window, open statuses only
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-09T17:00:00.000Z");
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_24H = 24 * MS_PER_HOUR;

describe("countUpcomingPendings", () => {
  it("returns the count from Prisma", async () => {
    prismaMock.pending.count.mockResolvedValueOnce(5);

    const result = await countUpcomingPendings(NOW);

    expect(result).toBe(5);
    expect(prismaMock.pending.count).toHaveBeenCalledTimes(1);
  });

  it("query uses status IN OPEN_STATUSES (PENDIENTE, PARCIAL)", async () => {
    await countUpcomingPendings(NOW);

    const call = prismaMock.pending.count.mock.calls[0]![0];
    expect(call.where.status.in).toContain("PENDIENTE");
    expect(call.where.status.in).toContain("PARCIAL");
  });

  it("query: promisedAt >= now (lower bound inclusive)", async () => {
    await countUpcomingPendings(NOW);

    const call = prismaMock.pending.count.mock.calls[0]![0];
    expect(call.where.promisedAt.gte).toBeInstanceOf(Date);
    // gte should equal or be very close to NOW
    expect(Math.abs(call.where.promisedAt.gte.getTime() - NOW.getTime())).toBeLessThan(
      1000,
    );
  });

  it("query: promisedAt <= now + 24h (upper bound inclusive — exactly now+24h should count)", async () => {
    await countUpcomingPendings(NOW);

    const call = prismaMock.pending.count.mock.calls[0]![0];
    expect(call.where.promisedAt.lte).toBeInstanceOf(Date);
    // lte should be NOW + 24h
    expect(
      Math.abs(call.where.promisedAt.lte.getTime() - (NOW.getTime() + MS_24H)),
    ).toBeLessThan(1000);
  });

  it("closed status (ENTREGADO) not included: only open statuses", async () => {
    await countUpcomingPendings(NOW);

    const call = prismaMock.pending.count.mock.calls[0]![0];
    expect(call.where.status.in).not.toContain("ENTREGADO");
  });

  it("works without a now argument", async () => {
    await expect(countUpcomingPendings()).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// El cursor es input controlado por el usuario (?cursor=...): nunca debe
// romper la consulta ni filtrarse a Prisma si apunta a un id inexistente.
// ---------------------------------------------------------------------------

describe("listPendings · seguridad del cursor", () => {
  it("ignora un cursor malformado y sirve la primera página", async () => {
    await listPendings({ cursor: "###no-es-base64###" });

    // decodeCursor descarta la basura antes de llegar a la base.
    expect(prismaMock.pending.findUnique).not.toHaveBeenCalled();
    const args = prismaMock.pending.findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it("ignora un cursor bien formado pero inexistente (primera página)", async () => {
    prismaMock.pending.findUnique.mockResolvedValue(null);

    await listPendings({ cursor: encodeCursor("fantasma-9999") });

    expect(prismaMock.pending.findUnique).toHaveBeenCalledWith({
      where: { id: "fantasma-9999" },
      select: { id: true },
    });
    const args = prismaMock.pending.findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it("pagina normalmente con un cursor válido y existente", async () => {
    prismaMock.pending.findUnique.mockResolvedValue({ id: "real-id" });

    await listPendings({ cursor: encodeCursor("real-id") });

    const args = prismaMock.pending.findMany.mock.calls[0]![0];
    expect(args.cursor).toEqual({ id: "real-id" });
    expect(args.skip).toBe(1);
  });
});

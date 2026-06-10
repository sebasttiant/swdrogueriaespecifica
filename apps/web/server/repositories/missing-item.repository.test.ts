import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    missingItem: {
      count: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  };
  return { prismaMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { encodeCursor } from "@/lib/pagination";
import {
  countOverdueMissingItems,
  listMissingItems,
} from "./missing-item.repository";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.missingItem.findMany.mockResolvedValue([]);
  prismaMock.missingItem.count.mockResolvedValue(0);
});

// El cursor es input controlado por el usuario (?cursor=...): nunca debe
// romper la consulta ni filtrarse a Prisma si apunta a un id inexistente.
describe("listMissingItems · seguridad del cursor", () => {
  it("ignora un cursor malformado y sirve la primera página", async () => {
    await listMissingItems({ cursor: "###no-es-base64###" });

    // decodeCursor descarta la basura antes de llegar a la base.
    expect(prismaMock.missingItem.findUnique).not.toHaveBeenCalled();
    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it("ignora un cursor bien formado pero inexistente (primera página)", async () => {
    prismaMock.missingItem.findUnique.mockResolvedValue(null);

    await listMissingItems({ cursor: encodeCursor("fantasma-9999") });

    expect(prismaMock.missingItem.findUnique).toHaveBeenCalledWith({
      where: { id: "fantasma-9999" },
      select: { id: true },
    });
    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it("pagina normalmente con un cursor válido y existente", async () => {
    prismaMock.missingItem.findUnique.mockResolvedValue({ id: "real-id" });

    await listMissingItems({ cursor: encodeCursor("real-id") });

    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.cursor).toEqual({ id: "real-id" });
    expect(args.skip).toBe(1);
  });
});

describe("listMissingItems · origen del pendiente", () => {
  it("devuelve el origen cuando el faltante está enlazado a un pendiente", async () => {
    const promisedAt = new Date("2026-06-09T15:00:00.000Z");
    prismaMock.missingItem.findMany.mockResolvedValue([
      {
        id: "missing-1",
        quantity: 2,
        status: "FALTANTE",
        originId: "pending-1",
        createdAt: new Date("2026-06-09T12:00:00.000Z"),
        product: {
          id: "product-1",
          name: "Vitamina C",
          code: "VIT-C",
          unit: "caja",
        },
        origin: {
          id: "pending-1",
          promisedAt,
          status: "PENDIENTE",
          customerName: "Cliente Uno",
        },
      },
    ]);

    const result = await listMissingItems({});

    expect(result.items).toEqual([
      expect.objectContaining({
        id: "missing-1",
        origin: {
          id: "pending-1",
          promisedAt,
          status: "PENDIENTE",
          customerName: "Cliente Uno",
        },
      }),
    ]);
    expect(prismaMock.missingItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          origin: {
            select: {
              id: true,
              promisedAt: true,
              status: true,
              customerName: true,
            },
          },
        }),
      }),
    );
  });

  it("devuelve origin null cuando el faltante no viene de un pendiente", async () => {
    prismaMock.missingItem.findMany.mockResolvedValue([
      {
        id: "missing-manual",
        quantity: 1,
        status: "PEDIDO",
        originId: null,
        createdAt: new Date("2026-06-09T12:00:00.000Z"),
        product: {
          id: "product-2",
          name: "Alcohol",
          code: "ALC",
          unit: "unidad",
        },
        origin: null,
      },
    ]);

    const result = await listMissingItems({});

    expect(result.items).toEqual([
      expect.objectContaining({ id: "missing-manual", origin: null }),
    ]);
  });
});

describe("countOverdueMissingItems", () => {
  it("cuenta faltantes abiertos con origen vencido", async () => {
    const now = new Date("2026-06-09T15:00:00.000Z");
    prismaMock.missingItem.count.mockResolvedValue(3);

    const result = await countOverdueMissingItems(now);

    expect(result).toBe(3);
    expect(prismaMock.missingItem.count).toHaveBeenCalledWith({
      where: {
        status: { in: ["FALTANTE", "PEDIDO"] },
        originId: { not: null },
        origin: { promisedAt: { lt: now } },
      },
    });
  });

  it("excluye faltantes sin origen y estados cerrados desde el filtro", async () => {
    const now = new Date("2026-06-09T15:00:00.000Z");

    await countOverdueMissingItems(now);

    const where = prismaMock.missingItem.count.mock.calls[0]![0].where;
    expect(where.originId).toEqual({ not: null });
    expect(where.status.in).toEqual(["FALTANTE", "PEDIDO"]);
    expect(where.status.in).not.toContain("RECIBIDO");
    expect(where.status.in).not.toContain("CANCELADO");
  });
});

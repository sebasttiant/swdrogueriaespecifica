import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Prisma — countExpiringBatches uses prisma.productBatch.count.
const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    productBatch: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  };
  return { prismaMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import {
  countExpiringBatches,
  expiryTierWhere,
  listExpiringBatches,
} from "./product-batch.repository";

// Fixed reference: 2026-06-09 12:00 UTC = 2026-06-09 07:00 Bogota.
const REF_NOW = new Date("2026-06-09T17:00:00.000Z"); // Bogota 12:00

beforeEach(() => {
  vi.clearAllMocks();
});

describe("countExpiringBatches", () => {
  it("returns counts from three parallel Prisma count calls", async () => {
    prismaMock.productBatch.count
      .mockResolvedValueOnce(3) // expired
      .mockResolvedValueOnce(2) // critical
      .mockResolvedValueOnce(1); // warning

    const result = await countExpiringBatches(REF_NOW);

    expect(result).toEqual({ expired: 3, critical: 2, warning: 1 });
    expect(prismaMock.productBatch.count).toHaveBeenCalledTimes(3);
  });

  it("expired count query: expiresAt < start-of-next-Bogota-day, quantity > 0", async () => {
    prismaMock.productBatch.count.mockResolvedValue(0);

    await countExpiringBatches(REF_NOW);

    const expiredCall = prismaMock.productBatch.count.mock.calls[0]![0];
    // expiresAt.lt should be > REF_NOW (start of the next calendar day in Bogota)
    expect(expiredCall.where.expiresAt.lt).toBeInstanceOf(Date);
    expect(expiredCall.where.expiresAt.lt.getTime()).toBeGreaterThan(
      REF_NOW.getTime(),
    );
    // No status filter (D3: all statuses included)
    expect(expiredCall.where.status).toBeUndefined();
    // quantity > 0
    expect(expiredCall.where.quantity).toEqual({ gt: 0 });
  });

  it("critical count query: expiresAt >= start-of-next-day AND < start-of-day+31, quantity > 0", async () => {
    prismaMock.productBatch.count.mockResolvedValue(0);

    await countExpiringBatches(REF_NOW);

    const criticalCall = prismaMock.productBatch.count.mock.calls[1]![0];
    expect(criticalCall.where.expiresAt.gte).toBeInstanceOf(Date);
    expect(criticalCall.where.expiresAt.lt).toBeInstanceOf(Date);
    // gte > REF_NOW (next Bogota calendar day boundary)
    expect(criticalCall.where.expiresAt.gte.getTime()).toBeGreaterThan(
      REF_NOW.getTime(),
    );
    // lt > gte (window is positive)
    expect(criticalCall.where.expiresAt.lt.getTime()).toBeGreaterThan(
      criticalCall.where.expiresAt.gte.getTime(),
    );
    expect(criticalCall.where.quantity).toEqual({ gt: 0 });
    expect(criticalCall.where.status).toBeUndefined();
  });

  it("warning count query: expiresAt >= start-of-day+31 AND < start-of-day+91, quantity > 0", async () => {
    prismaMock.productBatch.count.mockResolvedValue(0);

    await countExpiringBatches(REF_NOW);

    const warningCall = prismaMock.productBatch.count.mock.calls[2]![0];
    expect(warningCall.where.expiresAt.gte).toBeInstanceOf(Date);
    expect(warningCall.where.expiresAt.lt).toBeInstanceOf(Date);
    expect(warningCall.where.quantity).toEqual({ gt: 0 });
    expect(warningCall.where.status).toBeUndefined();
    // warning gte > critical gte
    const criticalCall = prismaMock.productBatch.count.mock.calls[1]![0];
    expect(warningCall.where.expiresAt.gte.getTime()).toBeGreaterThan(
      criticalCall.where.expiresAt.gte.getTime(),
    );
  });

  it("batch with quantity = 0 is excluded (quantity filter applies to all tiers)", async () => {
    prismaMock.productBatch.count.mockResolvedValue(0);

    await countExpiringBatches(REF_NOW);

    for (const call of prismaMock.productBatch.count.mock.calls) {
      expect(call[0].where.quantity).toEqual({ gt: 0 });
    }
  });

  it("no status filter — all BatchStatus values counted (D3: CUARENTENA and RETENIDO included)", async () => {
    prismaMock.productBatch.count.mockResolvedValue(5);

    await countExpiringBatches(REF_NOW);

    for (const call of prismaMock.productBatch.count.mock.calls) {
      expect(call[0].where.status).toBeUndefined();
    }
  });

  it("works without a ref argument (defaults to new Date())", async () => {
    prismaMock.productBatch.count.mockResolvedValue(0);

    await expect(countExpiringBatches()).resolves.toEqual({
      expired: 0,
      critical: 0,
      warning: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// listExpiringBatches — la lista que abre el chip de la barra de alertas.
//
// EL CONTRATO QUE IMPORTA: cuenta y lista tienen que preguntar EXACTAMENTE lo
// mismo. Si divergen, el chip dice 3 y la pantalla muestra 5, y la gente deja
// de creerle a la alerta. Por eso las dos pasan por `expiryTierWhere` y por eso
// eso se prueba acá y no se confía en la lectura del diff.
// ---------------------------------------------------------------------------

describe("expiryTierWhere", () => {
  it.each([
    ["expired", 0],
    ["critical", 1],
    ["warning", 2],
  ] as const)(
    "builds the same where that countExpiringBatches uses for %s",
    async (tier, callIndex) => {
      prismaMock.productBatch.count.mockResolvedValue(0);

      await countExpiringBatches(REF_NOW);
      const fromCounter = prismaMock.productBatch.count.mock.calls[callIndex]![0].where;

      expect(expiryTierWhere(tier, REF_NOW)).toEqual(fromCounter);
    },
  );

  it("always requires stock: a batch at zero is not an alert", () => {
    for (const tier of ["expired", "critical", "warning"] as const) {
      expect(expiryTierWhere(tier, REF_NOW).quantity).toEqual({ gt: 0 });
    }
  });

  // D3, igual que el contador: cuenta TODOS los status (DISPONIBLE, CUARENTENA,
  // RETENIDO). Un lote retenido que vence sigue siendo plata que se pierde.
  it("does not filter by status", () => {
    for (const tier of ["expired", "critical", "warning"] as const) {
      expect(expiryTierWhere(tier, REF_NOW).status).toBeUndefined();
    }
  });
});

describe("listExpiringBatches", () => {
  const row = (id: string) => ({
    id,
    batchCode: `L-${id}`,
    expiresAt: new Date("2026-06-01T05:00:00.000Z"),
    quantity: 5,
    location: null,
    status: "DISPONIBLE",
    product: { id: `p-${id}`, name: `Producto ${id}`, code: `C${id}`, unit: "Caja" },
  });

  it("queries with the tier's where and the soonest-first order", async () => {
    prismaMock.productBatch.findMany.mockResolvedValue([]);

    await listExpiringBatches({ tier: "critical", now: REF_NOW });

    const args = prismaMock.productBatch.findMany.mock.calls[0]![0];
    expect(args.where).toEqual(expiryTierWhere("critical", REF_NOW));
    expect(args.orderBy).toEqual([{ expiresAt: "asc" }, { id: "asc" }]);
  });

  it("brings the product along, because a lote number alone identifies nothing", async () => {
    prismaMock.productBatch.findMany.mockResolvedValue([]);

    await listExpiringBatches({ tier: "expired", now: REF_NOW });

    const args = prismaMock.productBatch.findMany.mock.calls[0]![0];
    expect(args.select.product.select).toMatchObject({ id: true, name: true });
  });

  it("asks for one extra row to know whether another page exists", async () => {
    prismaMock.productBatch.findMany.mockResolvedValue([]);

    await listExpiringBatches({ tier: "expired", take: 3, now: REF_NOW });

    expect(prismaMock.productBatch.findMany.mock.calls[0]![0].take).toBe(4);
  });

  it("trims the probe row and returns a cursor when there is more", async () => {
    prismaMock.productBatch.findMany.mockResolvedValue([row("a"), row("b"), row("c")]);

    const result = await listExpiringBatches({ tier: "expired", take: 2, now: REF_NOW });

    expect(result.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.nextCursor).not.toBeNull();
  });

  it("returns no cursor on the last page", async () => {
    prismaMock.productBatch.findMany.mockResolvedValue([row("a")]);

    const result = await listExpiringBatches({ tier: "expired", take: 2, now: REF_NOW });

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  // Un cursor que no emitimos nosotros no puede saltear filas: `decodeCursor`
  // lo rechaza y la consulta arranca de la primera página.
  it("ignores a forged cursor instead of skipping rows", async () => {
    prismaMock.productBatch.findMany.mockResolvedValue([]);

    await listExpiringBatches({ tier: "expired", cursor: "no-es-un-cursor", now: REF_NOW });

    const args = prismaMock.productBatch.findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });
});

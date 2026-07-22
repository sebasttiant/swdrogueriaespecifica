import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    missingItem: {
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  };
  return { prismaMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { encodeCursor } from "@/lib/pagination";
import {
  confirmMissingItem,
  countConfirmedMissingItems,
  countOrderedMissingItems,
  countOverdueMissingItems,
  createMissingItem,
  listMissingItems,
  lockMissingItemForUpdate,
  orderMissingItem,
} from "./missing-item.repository";

// Cliente de transacción falso: las funciones de lock/CAS solo corren dentro de
// una transacción interactiva, así que reciben `tx`, nunca el prisma default.
function txClient() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    missingItem: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
}

// SQL emitido por el tagged template de `$queryRaw`.
function sqlFrom(call: readonly unknown[]): string {
  return (call[0] as readonly string[]).join("?");
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.missingItem.findMany.mockResolvedValue([]);
  prismaMock.missingItem.count.mockResolvedValue(0);
});

describe("listMissingItems · active confirmation filter", () => {
  it("lists only active missing items by default", async () => {
    await listMissingItems({});

    expect(prismaMock.missingItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          confirmedAt: null,
          status: { in: ["FALTANTE", "PEDIDO"] },
        },
      }),
    );
  });

  it("keeps confirmed rows queryable when history is requested", async () => {
    await listMissingItems({ scope: "history" });

    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });

  // La cantidad pedida se muestra en la vista de Pedidos; el listado tiene que
  // traerla. Es distinta de `quantity` (necesidad), así que se selecciona aparte.
  it("selects orderedQuantity so the ordered amount can be shown", async () => {
    await listMissingItems({});

    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.select.orderedQuantity).toBe(true);
  });

  it("selects the authorizing user relation, limited to id and name", async () => {
    await listMissingItems({});

    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.select.confirmedBy).toEqual({ select: { id: true, name: true } });
  });
});

describe("lockMissingItemForUpdate", () => {
  it("emits SELECT ... FOR UPDATE on missing_items with the id bound as a parameter", async () => {
    const tx = txClient();
    tx.$queryRaw.mockResolvedValue([{ id: "missing-1", status: "FALTANTE" }]);

    const row = await lockMissingItemForUpdate(tx as never, "missing-1");

    const call = tx.$queryRaw.mock.calls[0]!;
    const sql = sqlFrom(call);
    // `FOR UPDATE` es la garantía real de serialización. Sin él, dos gerentes
    // leen `FALTANTE` a la vez y el último pedido pisa al primero.
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("FROM missing_items");
    // El id viaja como parámetro del template, nunca interpolado en el SQL.
    expect(call.slice(1)).toEqual(["missing-1"]);
    expect(sql).not.toContain("missing-1");
    expect(row).toEqual({ id: "missing-1", status: "FALTANTE" });
  });

  it("returns null when the row does not exist", async () => {
    const tx = txClient();

    await expect(lockMissingItemForUpdate(tx as never, "ghost")).resolves.toBeNull();
  });
});

describe("orderMissingItem", () => {
  it("only writes when the row is still FALTANTE and unconfirmed, returning the row count", async () => {
    const tx = txClient();
    const orderedAt = new Date("2026-07-09T12:00:00.000Z");

    const written = await orderMissingItem(tx as never, "missing-1", {
      supplierId: "sup-1",
      orderedById: "admin-1",
      orderedAt,
      orderedQuantity: 20,
    });

    expect(written).toBe(1);
    // El `where` es el compare-and-set: un faltante ya PEDIDO o ya confirmado
    // no coincide, así que la escritura no aplica en vez de pisar el estado.
    // `orderedQuantity` se persiste en el MISMO update atómico que el status.
    expect(tx.missingItem.updateMany).toHaveBeenCalledWith({
      where: { id: "missing-1", status: "FALTANTE", confirmedAt: null },
      data: {
        status: "PEDIDO",
        orderedAt,
        orderedById: "admin-1",
        supplierId: "sup-1",
        orderedQuantity: 20,
      },
    });
  });

  it("reports zero rows written when the compare-and-set misses", async () => {
    const tx = txClient();
    tx.missingItem.updateMany.mockResolvedValue({ count: 0 });

    const written = await orderMissingItem(tx as never, "missing-1", {
      supplierId: "sup-1",
      orderedById: "admin-1",
      orderedAt: new Date(),
      orderedQuantity: 20,
    });

    expect(written).toBe(0);
  });
});

describe("confirmMissingItem", () => {
  it("stores confirmation metadata guarded by status FALTANTE + confirmedAt: null, without deleting the row", async () => {
    const tx = txClient();
    const confirmedAt = new Date("2026-07-02T20:00:00.000Z");

    const written = await confirmMissingItem(tx as never, {
      id: "missing-1",
      confirmedById: "admin-1",
      confirmedAt,
      note: "Gestión OK",
    });

    expect(written).toBe(1);
    expect(tx.missingItem.updateMany).toHaveBeenCalledWith({
      // El CAS refuerza la invariante del service: confirmar dos veces, o
      // confirmar sobre un faltante que un pedido concurrente pasó a PEDIDO,
      // no coincide y no reescribe la confirmación (evita PEDIDO + confirmedAt).
      where: { id: "missing-1", status: "FALTANTE", confirmedAt: null },
      data: {
        confirmedAt,
        confirmedById: "admin-1",
        confirmationNote: "Gestión OK",
      },
    });
  });

  it("normalizes a missing note to null", async () => {
    const tx = txClient();

    await confirmMissingItem(tx as never, {
      id: "missing-1",
      confirmedById: "admin-1",
      confirmedAt: new Date(),
    });

    const args = tx.missingItem.updateMany.mock.calls[0]![0];
    expect(args.data.confirmationNote).toBeNull();
  });
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
        confirmedAt: null,
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

// Los chips de la cola operativa cuentan el estado GLOBAL, no el de la página
// paginada: mezclar ambas escalas en una misma franja daría números que no
// comparan entre sí.
describe("countOrderedMissingItems", () => {
  it("cuenta los faltantes en estado PEDIDO", async () => {
    prismaMock.missingItem.count.mockResolvedValue(3);

    await expect(countOrderedMissingItems()).resolves.toBe(3);
    expect(prismaMock.missingItem.count).toHaveBeenCalledWith({
      where: { status: "PEDIDO" },
    });
  });
});

describe("countConfirmedMissingItems", () => {
  // "OK gerencia" es la confirmación, y el service garantiza que un PEDIDO nunca
  // queda confirmado. Se cuenta por `confirmedAt`, que es el hecho registrado.
  it("cuenta los faltantes con OK gerencia por su fecha de confirmación", async () => {
    prismaMock.missingItem.count.mockResolvedValue(7);

    await expect(countConfirmedMissingItems()).resolves.toBe(7);
    expect(prismaMock.missingItem.count).toHaveBeenCalledWith({
      where: { confirmedAt: { not: null } },
    });
  });
});

describe("createMissingItem", () => {
  it("creates a manual missing item with originId null and a nullable note", async () => {
    prismaMock.missingItem.create.mockResolvedValue({ id: "missing-manual" });

    await expect(
      createMissingItem({
        productId: "prod-1",
        quantity: 4,
        originId: null,
        createdById: "admin-1",
        note: "Prioridad mostrador",
      }),
    ).resolves.toEqual({ id: "missing-manual" });

    expect(prismaMock.missingItem.create).toHaveBeenCalledWith({
      data: {
        productId: "prod-1",
        quantity: 4,
        originId: null,
        createdById: "admin-1",
        note: "Prioridad mostrador",
      },
    });
  });

  it("normalizes an omitted manual note to null without repurposing confirmationNote", async () => {
    prismaMock.missingItem.create.mockResolvedValue({ id: "missing-manual" });

    await createMissingItem({ productId: "prod-1", quantity: 1, originId: null });

    const args = prismaMock.missingItem.create.mock.calls[0]![0];
    expect(args.data.note).toBeNull();
    expect(args.data.confirmationNote).toBeUndefined();
  });
});

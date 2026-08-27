import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock del cliente Prisma: NO tocamos DB real. `$transaction` corre el callback
// con un `tx` falso y re-propaga si falla, igual que la transacción interactiva
// real — el rollback de la fila lo garantiza Prisma; acá verificamos que ambas
// escrituras viven en UNA sola transacción y que el error no se traga.
const { prismaMock, tx } = vi.hoisted(() => {
  const tx = {
    pending: {
      aggregate: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    pendingDelivery: { create: vi.fn() },
    missingItem: { create: vi.fn(), updateMany: vi.fn() },
    pendingInventoryReservation: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn(), delete: vi.fn(), update: vi.fn() },
    productBatch: { aggregate: vi.fn(), update: vi.fn() },
    product: { create: vi.fn() },
    // `lockPendingForUpdate` usa `$queryRaw` (SELECT ... FOR UPDATE), no
    // `findUnique`: bajo READ COMMITTED una relectura plana dentro de la
    // transacción no bloquea nada. Los tests afirman el SQL del lock, no solo
    // que "se usó el tx".
    $queryRaw: vi.fn(),
  };
  const prismaMock = {
    $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    // Nada del ciclo de entrega debe correr fuera de la transacción: tanto
    // `deliverPending` como `cancelPendingCommitment` toman el lock y escriben
    // con el `tx`. Los tests verifican que estas llamadas queden en cero.
    pending: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    missingItem: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
  };
  return { prismaMock, tx };
});

// El SQL del lock, tal como lo emite el tagged template de `$queryRaw`.
function lockSqlFrom(call: readonly unknown[]): string {
  return (call[0] as readonly string[]).join("?");
}

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

// Mock parcial del repositorio de pendientes para `getPendings`/`getPendingDashboard`:
// `createPending` queda REAL (delega a `importOriginal`) porque los tests de
// `registerPending` de arriba dependen de que corra contra el `tx` mockeado de
// Prisma. Solo las funciones de lectura se mockean, igual que
// `missing-item.service.test.ts` mockea su repositorio.
const { repo } = vi.hoisted(() => ({
  repo: {
    countOpenPendings: vi.fn(),
    countOverduePendings: vi.fn(),
    countUpcomingPendings: vi.fn(),
    listPendings: vi.fn(),
    listPendingIdentityQueue: vi.fn(),
    listUrgentPendings: vi.fn(),
    updatePendingManagementStatus: vi.fn(),
  },
}));

vi.mock("@/server/repositories/pending.repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/repositories/pending.repository")>();
  return { ...actual, ...repo };
});

import {
  cancelPendingCommitment,
  contactPending,
  deliverPending,
  getPendingDashboard,
  getPendings,
  getPendingIdentityQueue,
  PendingIdentityQueueForbiddenError,
  invoicePending,
  resolvePartialPending,
  updatePending,
  registerPending,
  setPendingManagementStatus,
} from "./pending.service";
import type { PendingListItem } from "@/server/repositories/pending.repository";
import type { SessionRole } from "@/lib/auth/session";
import { USER_ROLES } from "@/lib/auth/permissions";

// `promisedAt` va como instante UTC EXPLÍCITO (con la Z). Sin ella, JavaScript
// interpreta el literal como hora LOCAL, y el `toISOString()` con el que se arma
// la huella del pedido daría un valor distinto según la zona de la máquina: los
// tests de idempotencia pasarían en CI (UTC) y fallarían en cualquier equipo de
// la droguería (America/Bogota, UTC-5).
const baseInput = {
  productId: "prod_1",
  quantity: 5,
  promisedAt: new Date("2026-06-09T14:30:00Z"),
  createdById: "user_1",
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
};

// Stock FÍSICO en estantería, y cuánto de ese stock ya está comprometido con
// otros pendientes abiertos. La disponibilidad de un pendiente nuevo sale de la
// resta: se LEE el lote, nunca se lo modifica.
function mockStock(quantity: number, committedToOtherPendings = 0) {
  tx.$queryRaw.mockResolvedValue([]);
  tx.productBatch.aggregate.mockResolvedValue({ _sum: { quantity } });
  tx.pending.aggregate.mockResolvedValue({
    _sum: { inventoryReadyQuantity: committedToOtherPendings },
  });
}

// Typed fixture for `listPendings`/`listUrgentPendings` rows — mirrors
// `PendingListItem` exactly so tests catch accidental field drops/renames,
// not just a missing PII null-out.
function pendingRow(overrides: Partial<PendingListItem> = {}): PendingListItem {
  return {
    id: "pending-1",
    quantity: 5,
    status: "PENDIENTE",
    promisedAt: new Date("2026-07-10T10:00:00.000Z"),
    customerName: "Juan Pérez",
    note: null,
    customerPhone: "3001234567",
    customerAddress: "Calle 10 #43-20",
    createdBy: { id: "user-1", name: "Juan Esteban" },
    zone: "Norte",
    totalAmount: 50_000,
    paidAmount: 20_000,
    createdAt: new Date("2026-07-09T10:00:00.000Z"),
    deliveredQuantity: 0,
    cancelledQuantity: 0,
    identitySkippedReason: null,
    requestedLaboratory: null,
    product: {
      id: "prod-1",
      name: "Paracetamol",
      code: "P-001",
      unit: "unidad",
      orionCode: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(
    (fn: (client: typeof tx) => unknown) => fn(tx),
  );
  // Prisma devuelve un arreglo vacío, nunca undefined. Sin este default el
  // mock obligaba al código de producción a defenderse de un caso que la base
  // no produce.
  tx.pendingInventoryReservation.findMany.mockResolvedValue([]);
});

describe("registerPending", () => {
  it("con stock suficiente: crea el pendiente y NO crea faltante", async () => {
    tx.pending.create.mockResolvedValue({ id: "pend_1" });
    mockStock(10); // 10 >= 5 → sin déficit

    const result = await registerPending(baseInput);

    expect(result.pending.id).toBe("pend_1");
    expect(result.missingQuantity).toBe(0);
    expect(result.missingItem).toBeNull();
    expect(tx.missingItem.create).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    // Registrar el pedido de un cliente NO puede mover el conteo físico del
    // lote: el inventario de la droguería solo baja cuando hay una venta.
    expect(tx.productBatch.update).not.toHaveBeenCalled();
    expect(tx.pending.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          inventoryReadyQuantity: 5,
          reservedInventoryQuantity: 5,
        }),
      }),
    );
  });

  it("no promete dos veces las mismas unidades a dos clientes", async () => {
    tx.pending.create.mockResolvedValue({ id: "pend_b" });
    tx.missingItem.create.mockResolvedValue({ id: "miss_b", quantity: 4 });
    // 5 en estantería, 4 ya comprometidas con otro pendiente abierto: a este
    // pedido de 5 solo le queda 1, y los otros 4 hay que comprarlos.
    mockStock(5, 4);

    const result = await registerPending(baseInput);

    expect(result.sellableStock).toBe(1);
    expect(result.missingQuantity).toBe(4);
    expect(tx.productBatch.update).not.toHaveBeenCalled();
  });

  it("con stock insuficiente: crea el pendiente y un faltante por el déficit", async () => {
    tx.pending.create.mockResolvedValue({ id: "pend_2" });
    tx.missingItem.create.mockResolvedValue({
      id: "miss_1",
      productId: "prod_1",
      quantity: 3,
      originId: "pend_2",
    });
    mockStock(2); // requested 5 - stock 2 = déficit 3

    const result = await registerPending(baseInput);

    expect(result.pending.id).toBe("pend_2");
    expect(result.missingQuantity).toBe(3);
    expect(result.missingItem?.id).toBe("miss_1");
    expect(tx.missingItem.create).toHaveBeenCalledTimes(1);
    // El faltante se crea por el déficit y enlazado al pendiente origen.
    expect(tx.missingItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quantity: 3, originId: "pend_2" }),
      }),
    );
    // Ambas escrituras en la misma transacción y sobre el mismo tx client.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("producto manual: crea el producto marcado para revisión y luego el pendiente + faltante completo", async () => {
    const { productId: _omit, ...withoutProduct } = baseInput;
    tx.product.create.mockResolvedValue({ id: "prod_manual", needsReview: true });
    tx.pending.create.mockResolvedValue({ id: "pend_m", productId: "prod_manual" });
    tx.missingItem.create.mockResolvedValue({
      id: "miss_m",
      productId: "prod_manual",
      quantity: 5,
      originId: "pend_m",
    });
    mockStock(0); // producto nuevo: sin lotes → stock 0 → faltante = cantidad total

    const result = await registerPending({
      ...withoutProduct,
      manual: { name: "Ibuprofeno jarabe", unit: "frasco" },
    });

    // El producto se creó marcado para revisión, con código autogenerado.
    expect(tx.product.create).toHaveBeenCalledTimes(1);
    const createArg = tx.product.create.mock.calls[0]![0];
    expect(createArg.data).toMatchObject({
      name: "Ibuprofeno jarabe",
      unit: "frasco",
      needsReview: true,
    });
    expect(createArg.data.code).toMatch(/^MAN-/);
    // El pendiente y el faltante quedan enlazados al producto recién creado.
    expect(tx.pending.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ productId: "prod_manual" }),
      }),
    );
    expect(result.createdProduct?.id).toBe("prod_manual");
    expect(result.missingQuantity).toBe(5);
    expect(result.missingItem?.id).toBe("miss_m");
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("si falla la creación del faltante: propaga el error y todo va en una sola transacción (rollback)", async () => {
    tx.pending.create.mockResolvedValue({ id: "pend_3" });
    mockStock(0); // déficit 5 → intenta crear faltante
    tx.missingItem.create.mockRejectedValue(new Error("db down"));

    await expect(registerPending(baseInput)).rejects.toThrow("db down");

    // El pendiente y el faltante se intentaron dentro de la MISMA transacción;
    // al fallar el faltante, Prisma revierte la fila del pendiente. Verificamos
    // que el error no se tragó y que no hubo escrituras fuera de la transacción.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.pending.create).toHaveBeenCalledTimes(1);
    expect(tx.missingItem.create).toHaveBeenCalledTimes(1);
  });

  it("reproduce una misma clave con el mismo actor y payload sin crear otro pendiente", async () => {
    const existing = {
      id: "pend_existing",
      quantity: 5,
      inventoryReadyQuantity: 0,
      requestFingerprint: JSON.stringify({
        productId: "prod_1", manual: null, quantity: 5,
        promisedAt: "2026-06-09T14:30:00.000Z", customerName: null,
        customerPhone: null, customerAddress: null, note: null, zone: null,
        totalAmount: null, paidAmount: 0, createdById: "user_1",
      }),
    };
    prismaMock.pending.findUnique.mockResolvedValue(existing);
    prismaMock.missingItem.findFirst.mockResolvedValue(null);

    const result = await registerPending(baseInput);

    expect(result.replayed).toBe(true);
    expect(tx.pending.create).not.toHaveBeenCalled();
  });

  it("rechaza una misma clave con payload o actor distinto", async () => {
    prismaMock.pending.findUnique.mockResolvedValue({
      id: "pend_existing",
      requestFingerprint: "other-payload",
    });

    await expect(registerPending(baseInput)).rejects.toMatchObject({
      name: "Error",
      message: "idempotency key was already used for a different pending payload",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("recupera el ganador de una carrera P2002 sólo cuando la clave coincide", async () => {
    const winner = {
      id: "pend_winner",
      quantity: 5,
      inventoryReadyQuantity: 0,
      requestFingerprint: JSON.stringify({
        productId: "prod_1", manual: null, quantity: 5,
        promisedAt: "2026-06-09T14:30:00.000Z", customerName: null,
        customerPhone: null, customerAddress: null, note: null, zone: null,
        totalAmount: null, paidAmount: 0, createdById: "user_1",
      }),
    };
    prismaMock.pending.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    prismaMock.missingItem.findFirst.mockResolvedValue(null);
    tx.pending.create.mockRejectedValue({ code: "P2002" });

    const result = await registerPending(baseInput);

    expect(result).toMatchObject({ pending: { id: "pend_winner" }, replayed: true });
  });
});

type PendingRow = {
  id: string;
  quantity: number;
  deliveredQuantity: number;
  status: "PENDIENTE" | "PARCIAL" | "ENTREGADO" | "CANCELADO";
  createdById: string | null;
  inventoryReadyQuantity: number;
  invoicedQuantity: number;
  customerStatus: "POR_CONTACTAR" | "CONTACTADO" | "FACTURADO" | "ENTREGADO" | "CANCELADO";
};

function pendingForDelivery(overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    id: "pend-1",
    quantity: 10,
    deliveredQuantity: 0,
    status: "PENDIENTE",
    createdById: "op-1",
    inventoryReadyQuantity: 10,
    invoicedQuantity: 10,
    customerStatus: "FACTURADO",
    ...overrides,
  };
}

// `lockPendingForUpdate` devuelve la fila bloqueada; `$queryRaw` devuelve un array.
function mockLockedPending(row: PendingRow | null) {
  tx.$queryRaw.mockResolvedValue(row ? [row] : []);
}

// El CAS escribió la fila (caso normal, con el lock tomado).
function mockCasWrote(count: number) {
  tx.pending.updateMany.mockResolvedValue({ count });
}

describe("deliverPending", () => {
  const input = { id: "pend-1", quantity: 6, deliveredById: "op-1" };
  const now = new Date("2026-07-09T12:00:00.000Z");

  it("locks the pending row FOR UPDATE before any write", async () => {
    mockLockedPending(pendingForDelivery());
    mockCasWrote(1);

    await deliverPending(input, now);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = lockSqlFrom(tx.$queryRaw.mock.calls[0]!);
    // El lock de fila es LA garantía de serialización: sin `FOR UPDATE` dos
    // operadores leen el mismo `deliveredQuantity` y sobre-entregan.
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("FROM pendings");
    // Nunca `findUnique`: esa lectura no bloquea nada bajo READ COMMITTED.
    expect(tx.pending.findUnique).not.toHaveBeenCalled();
    // Y nada corre fuera de la transacción.
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.pending.updateMany).not.toHaveBeenCalled();
  });

  it("full delivery sets ENTREGADO and completedAt", async () => {
    mockLockedPending(pendingForDelivery({ deliveredQuantity: 0 }));
    mockCasWrote(1);

    const result = await deliverPending({ ...input, quantity: 10 }, now);

    expect(result.rejection).toBeNull();
    expect(result.pending).toEqual({
      id: "pend-1",
      status: "ENTREGADO",
      deliveredQuantity: 10,
      completedAt: now,
    });
    expect(tx.pending.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveredQuantity: 10,
          status: "ENTREGADO",
          completedAt: now,
        }),
      }),
    );
    expect(tx.missingItem.create).not.toHaveBeenCalled();
  });

  it("partial delivery sets PARCIAL and leaves completedAt null", async () => {
    mockLockedPending(pendingForDelivery({ deliveredQuantity: 0 }));
    mockCasWrote(1);

    const result = await deliverPending(input, now);

    expect(result.rejection).toBeNull();
    expect(result.pending).toEqual({
      id: "pend-1",
      status: "PARCIAL",
      deliveredQuantity: 6,
      completedAt: null,
    });
    expect(tx.missingItem.create).not.toHaveBeenCalled();
  });

  it("guards the write with a compare-and-set on the state read under the lock", async () => {
    mockLockedPending(pendingForDelivery({ status: "PARCIAL", deliveredQuantity: 4 }));
    mockCasWrote(1);

    await deliverPending(input, now);

    // El `where` del update repite el estado leído bajo el lock: si otra tx lo
    // cambió, la escritura no aplica en vez de pisarla.
    expect(tx.pending.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pend-1", status: "PARCIAL", deliveredQuantity: 4 },
      }),
    );
  });

  it("two sequential partials that sum to quantity end ENTREGADO", async () => {
    // First partial: 4 of 10.
    tx.$queryRaw.mockResolvedValueOnce([pendingForDelivery({ deliveredQuantity: 0 })]);
    tx.pending.updateMany.mockResolvedValueOnce({ count: 1 });
    const first = await deliverPending({ ...input, quantity: 4 }, now);
    expect(first.pending?.status).toBe("PARCIAL");

    // Second partial: remaining 6, completes the pending.
    tx.$queryRaw.mockResolvedValueOnce([
      pendingForDelivery({ status: "PARCIAL", deliveredQuantity: 4 }),
    ]);
    tx.pending.updateMany.mockResolvedValueOnce({ count: 1 });
    const second = await deliverPending({ ...input, quantity: 6 }, now);

    expect(second.rejection).toBeNull();
    expect(second.pending).toEqual({
      id: "pend-1",
      status: "ENTREGADO",
      deliveredQuantity: 10,
      completedAt: now,
    });
  });

  it("race: the lock returns the state a concurrent delivery already committed — over-delivery is rejected", async () => {
    // Dos operadores entregan 6 sobre un pendiente de 10. El primero confirma;
    // el segundo despierta del lock y lee `deliveredQuantity: 6`, no 0. Su
    // entrega de 6 excede lo que resta (4) y se rechaza sin escribir nada.
    mockLockedPending(pendingForDelivery({ status: "PARCIAL", deliveredQuantity: 6 }));

    const result = await deliverPending(input, now);

    expect(result.rejection).toBe("EXCEEDS_REMAINING");
    expect(result.pending).toBeNull();
    expect(tx.pendingDelivery.create).not.toHaveBeenCalled();
    expect(tx.pending.updateMany).not.toHaveBeenCalled();
  });

  it("over-delivery returns EXCEEDS_REMAINING and writes NOTHING", async () => {
    mockLockedPending(pendingForDelivery({ deliveredQuantity: 4 }));

    const result = await deliverPending({ ...input, quantity: 7 }, now);

    expect(result.rejection).toBe("EXCEEDS_REMAINING");
    expect(result.pending).toBeNull();
    expect(tx.pendingDelivery.create).not.toHaveBeenCalled();
    expect(tx.pending.updateMany).not.toHaveBeenCalled();
  });

  it("delivering a CANCELADO pending returns ALREADY_CANCELLED and writes nothing", async () => {
    mockLockedPending(pendingForDelivery({ status: "CANCELADO" }));

    const result = await deliverPending(input, now);

    expect(result.rejection).toBe("ALREADY_CANCELLED");
    expect(result.pending).toBeNull();
    expect(tx.pendingDelivery.create).not.toHaveBeenCalled();
    expect(tx.pending.updateMany).not.toHaveBeenCalled();
  });

  it("aborts the transaction when the compare-and-set writes no row", async () => {
    // Guarda de invariante: un llamador que se saltee el lock debe abortar (la
    // fila de PendingDelivery creada antes se revierte con la transacción),
    // nunca devolver una entrega que no se escribió.
    mockLockedPending(pendingForDelivery({ deliveredQuantity: 0 }));
    mockCasWrote(0);

    await expect(deliverPending(input, now)).rejects.toThrow(/concurrently/);
    expect(tx.pendingDelivery.create).toHaveBeenCalledTimes(1);
  });

  it("throws when the pending does not exist", async () => {
    mockLockedPending(null);

    await expect(deliverPending(input, now)).rejects.toThrow();
    expect(tx.pendingDelivery.create).not.toHaveBeenCalled();
  });

  it("runs inside a single $transaction and never touches MissingItem", async () => {
    mockLockedPending(pendingForDelivery({ deliveredQuantity: 0 }));
    mockCasWrote(1);

    await deliverPending(input, now);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.missingItem.create).not.toHaveBeenCalled();
  });
});

describe("cancelPendingCommitment", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");

  it("takes the same row lock as deliverPending and writes only with the tx client", async () => {
    mockLockedPending(pendingForDelivery({ status: "PENDIENTE" }));
    mockCasWrote(1);

    await cancelPendingCommitment({ id: "pend-1", cancelledById: "sup-1", canManageAll: true }, now);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    // El mismo `FOR UPDATE` sobre `pendings`: entregar y cancelar se serializan
    // sobre la misma fila, así que no pueden pisarse.
    expect(lockSqlFrom(tx.$queryRaw.mock.calls[0]!)).toContain("FOR UPDATE");
    expect(tx.pending.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.pending.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.pending.updateMany).not.toHaveBeenCalled();
  });

  it("cancels an open pending and sets cancelledAt/cancelledById/cancelReason", async () => {
    mockLockedPending(pendingForDelivery({ status: "PENDIENTE" }));
    mockCasWrote(1);

    const result = await cancelPendingCommitment(
      { id: "pend-1", cancelledById: "sup-1", reason: "Cliente desistió", canManageAll: true },
      now,
    );

    expect(result.rejection).toBeNull();
    expect(result.pending).toEqual({
      id: "pend-1",
      status: "CANCELADO",
      cancelledAt: now,
    });
    expect(tx.pending.updateMany).toHaveBeenCalledWith({
      // CAS sobre el estado leído bajo el lock.
      where: { id: "pend-1", status: "PENDIENTE" },
      data: {
        status: "CANCELADO",
        cancelledAt: now,
        cancelledById: "sup-1",
        cancelReason: "Cliente desistió",
      },
    });
  });

  it("libera el compromiso y cancela el faltante, sin inventar stock", async () => {
    mockLockedPending(pendingForDelivery({ status: "PARCIAL", deliveredQuantity: 4 }));
    mockCasWrote(1);
    tx.pendingInventoryReservation.findMany.mockResolvedValue([
      { id: "reservation-1", batchId: "batch-a", quantity: 2 },
      { id: "reservation-2", batchId: "batch-b", quantity: 4 },
    ]);

    await cancelPendingCommitment({ id: "pend-1", cancelledById: "sup-1", canManageAll: true }, now);

    // Cancelar libera unidades que quedan disponibles para otro cliente, pero
    // esas unidades nunca salieron del lote: sumarlas de vuelta inventaría
    // mercancía que jamás estuvo en la estantería.
    expect(tx.productBatch.update).not.toHaveBeenCalled();
    expect(tx.pendingInventoryReservation.deleteMany).toHaveBeenCalledWith({ where: { pendingId: "pend-1" } });
    expect(tx.missingItem.updateMany).toHaveBeenCalledWith({
      where: { originId: "pend-1", status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] } },
      data: { status: "CANCELADO" },
    });
  });

  it("rejects cancelling an ENTREGADO pending", async () => {
    mockLockedPending(pendingForDelivery({ status: "ENTREGADO" }));

    const result = await cancelPendingCommitment({ id: "pend-1", cancelledById: "sup-1", canManageAll: true }, now);

    expect(result.rejection).toBe("ALREADY_DELIVERED");
    expect(result.pending).toBeNull();
    expect(tx.pending.updateMany).not.toHaveBeenCalled();
  });

  it("rejects cancelling an already CANCELADO pending", async () => {
    mockLockedPending(pendingForDelivery({ status: "CANCELADO" }));

    const result = await cancelPendingCommitment({ id: "pend-1", cancelledById: "sup-1", canManageAll: true }, now);

    expect(result.rejection).toBe("ALREADY_CANCELLED");
    expect(tx.pending.updateMany).not.toHaveBeenCalled();
  });

  it("aborts the transaction when the compare-and-set writes no row", async () => {
    mockLockedPending(pendingForDelivery({ status: "PENDIENTE" }));
    mockCasWrote(0);

    await expect(
      cancelPendingCommitment({ id: "pend-1", cancelledById: "sup-1", canManageAll: true }, now),
    ).rejects.toThrow(/concurrently/);
  });

  it("throws when the pending does not exist", async () => {
    mockLockedPending(null);

    await expect(
      cancelPendingCommitment({ id: "missing", cancelledById: "sup-1", canManageAll: true }, now),
    ).rejects.toThrow();
  });

  it("race: a concurrent delivery completed the pending — cancel rejects ALREADY_DELIVERED and never writes", async () => {
    // La segunda transacción espera en el `FOR UPDATE` y, al despertar, lee el
    // ENTREGADO que la entrega concurrente acaba de confirmar. Sin el lock
    // habría leído PARCIAL y cancelado una entrega ya cumplida.
    mockLockedPending(pendingForDelivery({ status: "ENTREGADO", deliveredQuantity: 10 }));

    const result = await cancelPendingCommitment({ id: "pend-1", cancelledById: "sup-1", canManageAll: true }, now);

    expect(result.rejection).toBe("ALREADY_DELIVERED");
    expect(result.pending).toBeNull();
    expect(tx.pending.updateMany).not.toHaveBeenCalled();
  });
});

describe("getPendings · scope", () => {
  // `canViewCustomerIdentity` es del service (minimización de PII) y no debe
  // filtrarse al repositorio; `scope` sí tiene que llegar entero.
  it("forwards the scope to the repository without leaking the PII flag", async () => {
    repo.listPendings.mockResolvedValue({ items: [], nextCursor: null });

    await getPendings({ canViewCustomerIdentity: false, scope: "history" });

    expect(repo.listPendings).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "history" }),
    );
    expect(repo.listPendings.mock.calls[0]![0]).not.toHaveProperty(
      "canViewCustomerIdentity",
    );
  });

  it("leaves the scope undefined when the caller does not ask for history", async () => {
    repo.listPendings.mockResolvedValue({ items: [], nextCursor: null });

    await getPendings({ canViewCustomerIdentity: true });

    expect(repo.listPendings.mock.calls[0]![0].scope).toBeUndefined();
  });
});

describe("getPendings", () => {
  it("nulls customerName AND customerPhone when canViewCustomerIdentity is false, keeping every other field intact", async () => {
    const row = pendingRow();
    repo.listPendings.mockResolvedValue({ items: [row], nextCursor: null });

    const result = await getPendings({ canViewCustomerIdentity: false });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.customerName).toBeNull();
    // Teléfono y dirección identifican al cliente tanto como el nombre: se cortan igual.
    expect(result.items[0]!.customerPhone).toBeNull();
    expect(result.items[0]!.customerAddress).toBeNull();
    expect(result.items[0]).toEqual({ ...row, customerName: null, customerPhone: null, customerAddress: null });
  });

  it("returns customerName verbatim when canViewCustomerIdentity is true", async () => {
    const row = pendingRow();
    repo.listPendings.mockResolvedValue({ items: [row], nextCursor: null });

    const result = await getPendings({ canViewCustomerIdentity: true });

    expect(result.items[0]!.customerName).toBe("Juan Pérez");
    expect(result.items[0]).toEqual(row);
  });

  it("does not mutate the repository row in place when minimizing", async () => {
    const row = pendingRow();
    repo.listPendings.mockResolvedValue({ items: [row], nextCursor: null });

    await getPendings({ canViewCustomerIdentity: false });

    // The object handed back by the mocked repo must still hold the
    // original customerName — the service must return NEW objects.
    expect(row.customerName).toBe("Juan Pérez");
  });

  it("passes items with no customer identity through unchanged under both flags", async () => {
    const row = pendingRow({ customerName: null, customerPhone: null, customerAddress: null });
    repo.listPendings.mockResolvedValue({ items: [row], nextCursor: null });

    const resultDenied = await getPendings({ canViewCustomerIdentity: false });
    expect(resultDenied.items[0]).toEqual(row);

    const resultAllowed = await getPendings({ canViewCustomerIdentity: true });
    expect(resultAllowed.items[0]).toEqual(row);
  });

  it("forwards cursor/take to listPendings and passes nextCursor through unchanged", async () => {
    const row = pendingRow();
    repo.listPendings.mockResolvedValue({ items: [row], nextCursor: "cursor-abc" });

    const result = await getPendings({
      cursor: "cursor-in",
      take: 20,
      canViewCustomerIdentity: true,
    });

    expect(repo.listPendings).toHaveBeenCalledWith({
      cursor: "cursor-in",
      take: 20,
    });
    expect(result.nextCursor).toBe("cursor-abc");
  });
});

describe("getPendingDashboard", () => {
  const now = new Date("2026-07-09T10:00:00.000Z");

  beforeEach(() => {
    repo.countOpenPendings.mockResolvedValue(4);
    repo.countOverduePendings.mockResolvedValue(1);
    repo.countUpcomingPendings.mockResolvedValue(2);
  });

  it("nulls the customer identity of every `urgent` item when canViewCustomerIdentity is false, counts unchanged", async () => {
    const row = pendingRow();
    repo.listUrgentPendings.mockResolvedValue([row]);

    const result = await getPendingDashboard({ canViewCustomerIdentity: false, now });

    expect(result.urgent[0]!.customerName).toBeNull();
    expect(result.urgent[0]).toEqual({ ...row, customerName: null, customerPhone: null, customerAddress: null });
    expect(result.openCount).toBe(4);
    expect(result.overdueCount).toBe(1);
    expect(result.upcomingCount).toBe(2);
  });

  it("keeps customerName verbatim in `urgent` when canViewCustomerIdentity is true", async () => {
    const row = pendingRow();
    repo.listUrgentPendings.mockResolvedValue([row]);

    const result = await getPendingDashboard({ canViewCustomerIdentity: true, now });

    expect(result.urgent[0]!.customerName).toBe("Juan Pérez");
    expect(result.urgent[0]).toEqual(row);
  });

  it("does not mutate the repository row in place when minimizing", async () => {
    const row = pendingRow();
    repo.listUrgentPendings.mockResolvedValue([row]);

    await getPendingDashboard({ canViewCustomerIdentity: false, now });

    expect(row.customerName).toBe("Juan Pérez");
  });

  it("passes items with no customer identity through unchanged under both flags", async () => {
    const row = pendingRow({ customerName: null, customerPhone: null, customerAddress: null });
    repo.listUrgentPendings.mockResolvedValue([row]);

    const resultDenied = await getPendingDashboard({
      canViewCustomerIdentity: false,
      now,
    });
    expect(resultDenied.urgent[0]).toEqual(row);

    const resultAllowed = await getPendingDashboard({
      canViewCustomerIdentity: true,
      now,
    });
    expect(resultAllowed.urgent[0]).toEqual(row);
  });

  it("forwards `now` verbatim to countOverduePendings and countUpcomingPendings", async () => {
    repo.listUrgentPendings.mockResolvedValue([]);

    await getPendingDashboard({ canViewCustomerIdentity: true, now });

    // Exact reference/value check: a stray `new Date()` inside the service
    // would not equal the injected `now` and must fail this assertion.
    expect(repo.countOverduePendings).toHaveBeenCalledWith(now, undefined);
    expect(repo.countUpcomingPendings).toHaveBeenCalledWith(now, undefined);
  });

  it("scopes every dashboard query to the owner for an OPERADOR", async () => {
    repo.listUrgentPendings.mockResolvedValue([]);
    await getPendingDashboard({ canViewCustomerIdentity: true, now, scope: "owner", ownerId: "seller-1" });
    expect(repo.countOpenPendings).toHaveBeenCalledWith("seller-1");
    expect(repo.countOverduePendings).toHaveBeenCalledWith(now, "seller-1");
    expect(repo.countUpcomingPendings).toHaveBeenCalledWith(now, "seller-1");
    expect(repo.listUrgentPendings).toHaveBeenCalledWith(5, "seller-1");
  });
});

describe("customer lifecycle ownership and incremental invoice", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");

  it("fails closed for legacy ownerless Pending unless the actor is global", async () => {
    mockLockedPending(pendingForDelivery({ createdById: null }));
    await expect(contactPending({ id: "pend-1", actorId: "op-1" }, now)).resolves.toBe("NOT_OWNER");
  });

  it("does not regress FACTURADO to CONTACTADO", async () => {
    mockLockedPending(pendingForDelivery({ customerStatus: "FACTURADO" }));
    await expect(contactPending({ id: "pend-1", actorId: "op-1" }, now)).resolves.toBe("NOT_CONTACTABLE");
    expect(tx.pending.update).not.toHaveBeenCalled();
  });

  it("invoices newly available quantity after a partial delivery without leaving FACTURADO", async () => {
    mockLockedPending(pendingForDelivery({ status: "PARCIAL", deliveredQuantity: 6, inventoryReadyQuantity: 10, invoicedQuantity: 6, customerStatus: "FACTURADO" }));
    await expect(invoicePending({ id: "pend-1", actorId: "op-1", quantity: 4 }, now)).resolves.toBeNull();
    expect(tx.pending.update).toHaveBeenCalledWith({ where: { id: "pend-1" }, data: expect.objectContaining({ customerStatus: "FACTURADO", invoicedQuantity: 10 }) });
  });

  // Quien factura es la persona, mirando su propia caja; el sistema se entera
  // después. Exigirle un contacto previo, o esperar a que bodega cargara la
  // mercancía, dejaba al vendedor sin ninguna acción sobre su propio pendiente.
  it("factura sin contacto previo y sin que el sistema haya visto llegar stock", async () => {
    mockLockedPending(
      pendingForDelivery({
        customerStatus: "POR_CONTACTAR",
        inventoryReadyQuantity: 0,
        invoicedQuantity: 0,
        quantity: 10,
      }),
    );

    await expect(
      invoicePending({ id: "pend-1", actorId: "op-1", quantity: 10 }, now),
    ).resolves.toBeNull();
    expect(tx.pending.update).toHaveBeenCalledWith({
      where: { id: "pend-1" },
      data: expect.objectContaining({ customerStatus: "FACTURADO", invoicedQuantity: 10 }),
    });
  });

  it("no deja facturar más de lo que el cliente pidió", async () => {
    mockLockedPending(pendingForDelivery({ quantity: 10, invoicedQuantity: 8 }));

    await expect(
      invoicePending({ id: "pend-1", actorId: "op-1", quantity: 5 }, now),
    ).resolves.toBe("NOT_AVAILABLE");
    expect(tx.pending.update).not.toHaveBeenCalled();
  });

  it("no factura un pendiente ya cerrado", async () => {
    mockLockedPending(pendingForDelivery({ customerStatus: "CANCELADO" }));

    await expect(
      invoicePending({ id: "pend-1", actorId: "op-1", quantity: 1 }, now),
    ).resolves.toBe("ALREADY_TERMINAL");
    expect(tx.pending.update).not.toHaveBeenCalled();
  });

  it("rechaza facturar un pendiente ajeno", async () => {
    mockLockedPending(pendingForDelivery({ createdById: "otro-vendedor" }));

    await expect(
      invoicePending({ id: "pend-1", actorId: "op-1", quantity: 1 }, now),
    ).resolves.toBe("NOT_OWNER");
    expect(tx.pending.update).not.toHaveBeenCalled();
  });
});

describe("setPendingManagementStatus", () => {
  it("delega el compare-and-set con los estados elegibles de gestión", async () => {
    repo.updatePendingManagementStatus.mockResolvedValue(1);

    await setPendingManagementStatus({ id: "pend-1", status: "SOLICITADO" });

    expect(repo.updatePendingManagementStatus).toHaveBeenCalledWith({
      id: "pend-1", purchaseStatus: "SOLICITADO", expectedPurchaseStatus: undefined,
    });
  });

  it("forwards expectedStatus=PENDIENTE to the repository CAS", async () => {
    repo.updatePendingManagementStatus.mockResolvedValue(1);

    await setPendingManagementStatus({
      id: "pend-1",
      status: "SOLICITADO",
      expectedStatus: "PENDIENTE",
    });

    expect(repo.updatePendingManagementStatus).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPurchaseStatus: "POR_PEDIR" }),
    );
  });

  it("devuelve el pendiente actualizado cuando el CAS escribe una fila", async () => {
    repo.updatePendingManagementStatus.mockResolvedValue(1);

    const result = await setPendingManagementStatus({
      id: "pend-1",
      status: "COTIZANDO",
    });

    expect(result).toEqual({
      pending: { id: "pend-1", status: "COTIZANDO" },
      rejection: null,
    });
  });

  // count 0 = no existe o ya entró a entrega/terminal: rechazo, no error.
  it("rechaza con NOT_ELIGIBLE cuando el CAS no escribe (no elegible)", async () => {
    repo.updatePendingManagementStatus.mockResolvedValue(0);

    const result = await setPendingManagementStatus({
      id: "pend-entregado",
      status: "AGOTADO",
    });

    expect(result).toEqual({ pending: null, rejection: "NOT_ELIGIBLE" });
  });

  // AGOTADO es una señal, no una cancelación: nunca escribe CANCELADO.
  it("marcar AGOTADO fija ese estado, no CANCELADO", async () => {
    repo.updatePendingManagementStatus.mockResolvedValue(1);

    const result = await setPendingManagementStatus({
      id: "pend-1",
      status: "AGOTADO",
    });

    expect(result.pending?.status).toBe("AGOTADO");
  });
});

// --------------------------------------------------------------------------
// Llegó solo una parte: el vendedor entrega lo que hay y pregunta. Las tres
// respuestas ya existían en la operación —dos son las notas que el vendedor
// escribe hoy en su tabla ("cliente espera", "va con pedido")—.
// --------------------------------------------------------------------------
describe("resolvePartialPending", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");

  it("si el cliente espera, deja la nota y NO cierra el pendiente", async () => {
    mockLockedPending(pendingForDelivery({ status: "PARCIAL", quantity: 5, deliveredQuantity: 3 }));
    tx.pending.findUnique.mockResolvedValue({ note: null });

    await expect(
      resolvePartialPending({ id: "pend-1", decision: "espera", actorId: "op-1" }, now),
    ).resolves.toBeNull();

    // La decisión se PERSISTE, no solo su nota: sin esto la fila no sabía que
    // ya se había respondido y volvía a preguntar para siempre.
    expect(tx.pending.update).toHaveBeenCalledWith({
      where: { id: "pend-1" },
      data: {
        note: "Cliente espera los 2 restantes",
        partialDecision: "ESPERA",
        partialDecisionAt: now,
      },
    });
    expect(tx.pending.updateMany).not.toHaveBeenCalled();
  });

  it("conserva la nota que el vendedor ya había escrito", async () => {
    mockLockedPending(pendingForDelivery({ status: "PARCIAL", quantity: 5, deliveredQuantity: 3 }));
    tx.pending.findUnique.mockResolvedValue({ note: "Va con pedido" });

    await resolvePartialPending({ id: "pend-1", decision: "va_con_pedido", actorId: "op-1" }, now);

    expect(tx.pending.update).toHaveBeenCalledWith({
      where: { id: "pend-1" },
      data: {
        note: "Va con pedido · Los 2 restantes van con otro pedido",
        partialDecision: "VA_CON_PEDIDO",
        partialDecisionAt: now,
      },
    });
  });

  // T2.2b (actualización intencional): antes de la ecuación terminal este test
  // esperaba status ENTREGADO — el cierre parcial se disfrazaba de entrega
  // completa y la única huella de lo no entregado era texto en cancelReason.
  // Ahora espera el estado propio y la cantidad cancelada.
  it("si no los espera, cierra como CLOSED_PARTIAL y libera la necesidad de compra", async () => {
    mockLockedPending(pendingForDelivery({ status: "PARCIAL", quantity: 5, deliveredQuantity: 3 }));
    mockCasWrote(1);

    await expect(
      resolvePartialPending({ id: "pend-1", decision: "cerrar", actorId: "op-1" }, now),
    ).resolves.toBeNull();

    expect(tx.pending.updateMany).toHaveBeenCalledWith({
      where: { id: "pend-1", status: "PARCIAL" },
      data: expect.objectContaining({
        status: "CLOSED_PARTIAL",
        customerStatus: "ENTREGADO",
        // 5 pedidos, 3 entregados => 2 cancelados: la ecuación cierra.
        cancelledQuantity: 2,
      }),
    });
    expect(tx.missingItem.updateMany).toHaveBeenCalledWith({
      where: { originId: "pend-1", status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] } },
      data: { status: "CANCELADO" },
    });
  });

  it("no resuelve un pendiente sin entrega parcial", async () => {
    mockLockedPending(pendingForDelivery({ status: "PENDIENTE" }));

    await expect(
      resolvePartialPending({ id: "pend-1", decision: "cerrar", actorId: "op-1" }, now),
    ).resolves.toBe("NOT_PARTIAL");
  });

  it("rechaza resolver un pendiente ajeno", async () => {
    mockLockedPending(pendingForDelivery({ status: "PARCIAL", createdById: "otro" }));

    await expect(
      resolvePartialPending({ id: "pend-1", decision: "espera", actorId: "op-1" }, now),
    ).resolves.toBe("NOT_OWNER");
    expect(tx.pending.update).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// T2.2b — Ecuación terminal del cierre parcial.
//
// Hoy un pendiente de 10 del que salieron 3 y cuyo resto el cliente no espera
// se cierra como ENTREGADO. La base afirma que se entregó, y lo único que dice
// que faltaron 7 es un texto libre en `cancelReason`.
//
// Eso no es un detalle cosmético: cualquier lectura que cuente entregados —la
// revisión de pendientes, los reportes, la conciliación— cuenta 10 donde
// salieron 3. El spec pide un estado propio y la ecuación cerrada:
//
//   CLOSED_PARTIAL  ⟺  delivered > 0 ∧ cancelled > 0 ∧ delivered + cancelled = requested
// --------------------------------------------------------------------------
describe("resolvePartialPending · ecuación terminal (T2.2b)", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");

  it("cierra como CLOSED_PARTIAL, no como ENTREGADO", async () => {
    mockLockedPending(pendingForDelivery({ status: "PARCIAL", deliveredQuantity: 3 }));
    mockCasWrote(1);

    await resolvePartialPending({ id: "pend-1", decision: "cerrar", actorId: "op-1" }, now);

    expect(tx.pending.updateMany).toHaveBeenCalledWith({
      where: { id: "pend-1", status: "PARCIAL" },
      data: expect.objectContaining({ status: "CLOSED_PARTIAL" }),
    });
  });

  it("registra en cancelledQuantity lo que NO se entregó", async () => {
    mockLockedPending(pendingForDelivery({ status: "PARCIAL", deliveredQuantity: 3 }));
    mockCasWrote(1);

    await resolvePartialPending({ id: "pend-1", decision: "cerrar", actorId: "op-1" }, now);

    expect(tx.pending.updateMany).toHaveBeenCalledWith({
      where: { id: "pend-1", status: "PARCIAL" },
      // 10 pedidos, 3 entregados => 7 cancelados.
      data: expect.objectContaining({ cancelledQuantity: 7 }),
    });
  });

  // La invariante del spec, aseverada como ecuación y no como dos números
  // sueltos: es la propiedad que tiene que valer, no el caso particular.
  it("la ecuación cierra: entregado + cancelado = pedido", async () => {
    const pedido = 10;
    const entregado = 3;
    mockLockedPending(
      pendingForDelivery({ status: "PARCIAL", quantity: pedido, deliveredQuantity: entregado }),
    );
    mockCasWrote(1);

    await resolvePartialPending({ id: "pend-1", decision: "cerrar", actorId: "op-1" }, now);

    const written = tx.pending.updateMany.mock.calls.at(-1)?.[0]?.data as {
      cancelledQuantity?: number;
    };
    expect(entregado + (written?.cancelledQuantity ?? 0)).toBe(pedido);
  });

  // Un cierre sin ninguna entrega es una cancelación, no un cierre parcial, y
  // ya lo rechaza `NOT_PARTIAL`. Este test fija que el estado nuevo NUNCA se
  // use con entregado en cero: `CLOSED_PARTIAL` exige `delivered > 0`.
  it("no llega a CLOSED_PARTIAL sin ninguna entrega", async () => {
    mockLockedPending(pendingForDelivery({ status: "PENDIENTE", deliveredQuantity: 0 }));

    await expect(
      resolvePartialPending({ id: "pend-1", decision: "cerrar", actorId: "op-1" }, now),
    ).resolves.toBe("NOT_PARTIAL");
    expect(tx.pending.updateMany).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// Corregir un pendiente. Dos autoridades sobre la misma acción: gerencia sin
// límite sobre cualquiera, el vendedor una sola vez sobre el suyo.
//
// Equivocarse al cargar pasa; corregir en bucle es reescribir la historia de un
// compromiso con un cliente sin que nadie pueda ver cuál fue la promesa.
// --------------------------------------------------------------------------
describe("updatePending", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");

  const correction = {
    productId: "prod-1",
    quantity: 12,
    promisedAt: new Date("2026-08-01T15:00:00.000Z"),
    customerName: "Ana corregida",
    customerPhone: "3001112233",
  };

  function lockedForEdit(overrides: Record<string, unknown> = {}) {
    tx.$queryRaw.mockResolvedValue([
      {
        id: "pend-1",
        productId: "prod-1",
        quantity: 10,
        status: "PENDIENTE",
        createdById: "op-1",
        deliveredQuantity: 0,
        invoicedQuantity: 0,
        sellerEditedAt: null,
        customerName: "Ana",
        customerPhone: "3009998877",
        customerAddress: null,
        note: null,
        zone: null,
        totalAmount: null,
        paidAmount: 0,
        promisedAt: new Date("2026-07-10T10:00:00.000Z"),
        ...overrides,
      },
    ]);
  }

  it("el vendedor corrige el suyo y consume su única oportunidad", async () => {
    lockedForEdit();

    const result = await updatePending(
      { ...correction, id: "pend-1", actorId: "op-1", canManageAll: false },
      now,
    );

    expect(result.rejection).toBeNull();
    expect(tx.pending.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quantity: 12, sellerEditedAt: now }),
      }),
    );
  });

  it("rechaza la segunda corrección del vendedor", async () => {
    lockedForEdit({ sellerEditedAt: new Date("2026-07-08T10:00:00.000Z") });

    const result = await updatePending(
      { ...correction, id: "pend-1", actorId: "op-1", canManageAll: false },
      now,
    );

    expect(result.rejection).toBe("ALREADY_EDITED");
    expect(tx.pending.update).not.toHaveBeenCalled();
  });

  it("gerencia corrige sin límite y NO consume el cupo del vendedor", async () => {
    lockedForEdit({ sellerEditedAt: new Date("2026-07-08T10:00:00.000Z") });

    const result = await updatePending(
      { ...correction, id: "pend-1", actorId: "adm-1", canManageAll: true },
      now,
    );

    expect(result.rejection).toBeNull();
    expect(tx.pending.update).toHaveBeenCalledTimes(1);
    // El cupo del vendedor es SUYO: una corrección de gerencia no puede
    // gastárselo, así que ni siquiera escribe la columna.
    expect(tx.pending.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ sellerEditedAt: expect.anything() }),
      }),
    );
  });

  it("rechaza corregir un pendiente ajeno", async () => {
    lockedForEdit({ createdById: "otro" });

    const result = await updatePending(
      { ...correction, id: "pend-1", actorId: "op-1", canManageAll: false },
      now,
    );

    expect(result.rejection).toBe("NOT_OWNER");
  });

  it("no corrige un pendiente ya cerrado", async () => {
    lockedForEdit({ status: "ENTREGADO" });

    const result = await updatePending(
      { ...correction, id: "pend-1", actorId: "adm-1", canManageAll: true },
      now,
    );

    expect(result.rejection).toBe("ALREADY_CLOSED");
  });

  it("no deja bajar la cantidad por debajo de lo ya facturado o entregado", async () => {
    lockedForEdit({ invoicedQuantity: 8, deliveredQuantity: 5 });

    const result = await updatePending(
      { ...correction, quantity: 4, id: "pend-1", actorId: "adm-1", canManageAll: true },
      now,
    );

    expect(result.rejection).toBe("BELOW_COMMITTED");
    expect(tx.pending.update).not.toHaveBeenCalled();
  });

  it("al cambiar de producto cancela el faltante que ya no sirve", async () => {
    lockedForEdit();

    await updatePending(
      { ...correction, productId: "prod-2", id: "pend-1", actorId: "adm-1", canManageAll: true },
      now,
    );

    expect(tx.missingItem.updateMany).toHaveBeenCalledWith({
      where: { originId: "pend-1", status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] } },
      data: { status: "CANCELADO" },
    });
  });
});

// --------------------------------------------------------------------------
// S2b · 2-A — la cola de identidad pendiente: quién ve qué.
//
// La política de rol vive en `permissions.ts` y se RESUELVE acá; el
// repositorio recibe un alcance ya decidido y no vuelve a opinar. Un segundo
// lugar que decida quién ve qué es exactamente cómo una de las dos copias
// termina filtrando, y filtrando en silencio.
// --------------------------------------------------------------------------
describe("getPendingIdentityQueue · alcance por rol", () => {
  const EMPTY = { items: [], nextCursor: null };

  beforeEach(() => {
    repo.listPendingIdentityQueue.mockResolvedValue(EMPTY);
  });

  // Gerencia: ve la cola entera, así que el filtro por dueño NO viaja.
  it.each(["SUPERADMIN", "ADMIN", "SUPERVISOR"] as const)(
    "%s consulta la cola global, sin filtro de dueño",
    async (role) => {
      await getPendingIdentityQueue({ role, userId: "u-1" });

      expect(repo.listPendingIdentityQueue).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: undefined }),
      );
    },
  );

  // Quien no ve toda la cola recibe SOLO lo suyo. El filtro viaja al
  // repositorio, que es donde entra en el WHERE: si se aplicara después de
  // contar, el conteo seguiría siendo el global y la fuga sería el número.
  it("BODEGA consulta solo lo que cargó esa persona", async () => {
    await getPendingIdentityQueue({ role: "BODEGA", userId: "u-7" });

    expect(repo.listPendingIdentityQueue).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "u-7" }),
    );
  });

  // OPERADOR captura pendientes, pero no tiene `canFixProductIdentity`: no
  // puede resolver una sola fila de esta cola. Se lo rechaza en el borde en
  // vez de mostrarle trabajo sin acciones disponibles.
  it("rechaza a OPERADOR, que no puede resolver ninguna fila", async () => {
    await expect(
      getPendingIdentityQueue({ role: "OPERADOR", userId: "u-7" }),
    ).rejects.toBeInstanceOf(PendingIdentityQueueForbiddenError);

    expect(repo.listPendingIdentityQueue).not.toHaveBeenCalled();
  });

  // Los tres grupos tienen que PARTIR el conjunto de roles. Si mañana se
  // agrega uno, este test lo obliga a elegir bando en vez de heredar la cola
  // —o el rechazo— por omisión y sin que nadie lo note.
  it("clasifica a todos los roles del sistema, sin huérfanos", () => {
    const clasificados = ["SUPERADMIN", "ADMIN", "SUPERVISOR", "BODEGA", "OPERADOR"];

    expect([...clasificados].sort()).toEqual([...USER_ROLES].sort());
  });

  it("propaga cursor y take sin reinterpretarlos", async () => {
    await getPendingIdentityQueue({
      role: "ADMIN",
      userId: "u-1",
      cursor: "cursor-op",
      take: 5,
    });

    expect(repo.listPendingIdentityQueue).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "cursor-op", take: 5 }),
    );
  });

  // La autoridad se comprueba ANTES de consultar. Hoy los cinco roles pueden,
  // así que este caso no lo alcanza ninguno: existe para el día que se agregue
  // un rol nuevo, que es justamente cuando un permiso implícito se convierte
  // en una fuga que nadie escribió.
  it("rechaza un rol sin autoridad ANTES de tocar el repositorio", async () => {
    const intruder = "AUDITOR_EXTERNO" as unknown as SessionRole;

    await expect(
      getPendingIdentityQueue({ role: intruder, userId: "u-9" }),
    ).rejects.toBeInstanceOf(PendingIdentityQueueForbiddenError);

    expect(repo.listPendingIdentityQueue).not.toHaveBeenCalled();
  });

  // Ningún otro test mira el valor devuelto: sin esto, mutar el cuerpo para
  // devolver una página fabricada pasa la suite entera.
  it("devuelve la página del repositorio tal cual", async () => {
    const page = {
      items: [{ productId: "p-1", productName: "Dipirona", productCode: "C1", pendingCount: 2 }],
      nextCursor: "cursor-siguiente",
    };
    repo.listPendingIdentityQueue.mockResolvedValue(page);

    await expect(getPendingIdentityQueue({ role: "ADMIN", userId: "u-1" })).resolves.toBe(page);
  });

  // El repositorio lee `ownerId: undefined` como cola GLOBAL, así que un
  // `userId` vacío en un rol acotado tiene que fallar, NUNCA ensanchar.
  it("falla en vez de ensanchar el alcance cuando falta el userId", async () => {
    await expect(getPendingIdentityQueue({ role: "BODEGA", userId: "" })).rejects.toThrow(
      /userId/,
    );

    expect(repo.listPendingIdentityQueue).not.toHaveBeenCalled();
  });

  // Los defaults son del repositorio (`clampTake`, `decodeQueueCursor`). El
  // servicio no puede adelantarse a fijarlos, ni agregar campos al llamado.
  it("no inventa defaults ni campos extra", async () => {
    await getPendingIdentityQueue({ role: "ADMIN", userId: "u-1" });

    expect(repo.listPendingIdentityQueue).toHaveBeenCalledWith({
      ownerId: undefined,
      cursor: undefined,
      take: undefined,
    });
    expect(repo.listPendingIdentityQueue).toHaveBeenCalledTimes(1);
  });

  // Es una LECTURA. Ninguna rama puede escribir, ni la autorizada ni la
  // rechazada: la cola se deriva del estado actual y no marca nada.
  it("no escribe nada: ni la consulta autorizada ni el rechazo", async () => {
    await getPendingIdentityQueue({ role: "BODEGA", userId: "u-7" });
    await expect(
      getPendingIdentityQueue({
        role: "AUDITOR_EXTERNO" as unknown as SessionRole,
        userId: "u-9",
      }),
    ).rejects.toBeInstanceOf(PendingIdentityQueueForbiddenError);

    expect(prismaMock.pending.update).not.toHaveBeenCalled();
    expect(prismaMock.pending.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

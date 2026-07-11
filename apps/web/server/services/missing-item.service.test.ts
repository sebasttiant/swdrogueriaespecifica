import { beforeEach, describe, expect, it, vi } from "vitest";

// Cliente Prisma falso: `$transaction` corre el callback con un `tx` centinela
// y re-propaga el error, igual que `pending.service.test.ts`. Así verificamos
// que TODO el flujo de `orderMissingItem` corre en UNA sola transacción y que
// cada lectura/escritura del repositorio recibe el cliente `tx`.
const { prismaMock, tx } = vi.hoisted(() => {
  const tx = { __brand: "tx-client" as const };
  const prismaMock = {
    $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  return { prismaMock, tx };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

const { repo } = vi.hoisted(() => ({
  repo: {
    confirmMissingItem: vi.fn(),
    countConfirmedMissingItems: vi.fn(),
    countOpenMissingItems: vi.fn(),
    countOrderedMissingItems: vi.fn(),
    countOverdueMissingItems: vi.fn(),
    // `lockMissingItemForUpdate` (SELECT ... FOR UPDATE) reemplaza la lectura
    // plana: es lo que serializa pedidos/confirmaciones sobre el mismo
    // faltante. El SQL del lock se afirma en `missing-item.repository.test.ts`.
    lockMissingItemForUpdate: vi.fn(),
    listMissingItems: vi.fn(),
    orderMissingItem: vi.fn(),
    createMissingItem: vi.fn(),
  },
}));

vi.mock("@/server/repositories/missing-item.repository", () => repo);

const { supplierRepo } = vi.hoisted(() => ({
  supplierRepo: {
    findSupplierById: vi.fn(),
    upsertSupplierByName: vi.fn(),
    upsertProductSupplierLink: vi.fn(),
  },
}));

vi.mock("@/server/repositories/supplier.repository", () => supplierRepo);

const { productRepo } = vi.hoisted(() => ({
  productRepo: {
    findProductById: vi.fn(),
  },
}));

vi.mock("@/server/repositories/product.repository", () => productRepo);

// La cadena de pedido NUNCA debe importar/llamar al repositorio de pendientes.
// Lo mockeamos con espías para poder afirmar que ninguna de sus funciones se
// invoca desde este flujo.
const { pendingRepo } = vi.hoisted(() => ({
  pendingRepo: {
    lockPendingForUpdate: vi.fn(),
    createPendingDelivery: vi.fn(),
    updatePendingAfterDelivery: vi.fn(),
    cancelPending: vi.fn(),
  },
}));

vi.mock("@/server/repositories/pending.repository", () => pendingRepo);

import {
  confirmMissingItemOk,
  createManualMissingItem,
  getMissingItems,
  getMissingItemsSummary,
  orderMissingItem,
} from "./missing-item.service";
import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

beforeEach(() => vi.clearAllMocks());

// Typed fixture for `listMissingItems` rows — mirrors `MissingItemListItem`
// exactly so tests catch accidental field drops/renames, not just missing PII.
function missingItemRow(
  overrides: Partial<MissingItemListItem> = {},
): MissingItemListItem {
  return {
    id: "missing-1",
    quantity: 3,
    note: null,
    status: "FALTANTE",
    originId: "pending-1",
    confirmedAt: null,
    confirmedById: null,
    confirmationNote: null,
    orderedAt: null,
    orderedById: null,
    supplierId: null,
    createdAt: new Date("2026-07-01T10:00:00.000Z"),
    product: {
      id: "prod-1",
      name: "Paracetamol",
      code: "P-001",
      unit: "unidad",
      laboratory: null,
    },
    origin: {
      id: "pending-1",
      promisedAt: new Date("2026-07-03T10:00:00.000Z"),
      status: "PENDIENTE",
      customerName: "Juan Pérez",
    },
    supplier: null,
    ...overrides,
  };
}

// Deferred promise: lets a test control exactly when a mocked async call
// resolves, so concurrency can be asserted without timing hacks.
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function missing(overrides = {}) {
  return {
    id: "missing-1",
    status: "FALTANTE",
    confirmedAt: null,
    confirmedById: null,
    confirmationNote: null,
    ...overrides,
  };
}

describe("confirmMissingItemOk", () => {
  it("confirms an active missing item with the management user id, under the row lock", async () => {
    const confirmedAt = new Date("2026-07-02T20:00:00.000Z");
    repo.lockMissingItemForUpdate.mockResolvedValue(missing());
    repo.confirmMissingItem.mockResolvedValue(1);

    const result = await confirmMissingItemOk({
      id: "missing-1",
      confirmedById: "admin-1",
      confirmedAt,
    });

    expect(result.changed).toBe(true);
    expect(result.item).toEqual(
      expect.objectContaining({ confirmedAt, confirmedById: "admin-1" }),
    );
    // Lock y escritura corren en la MISMA transacción interactiva: si un pedido
    // concurrente pasó el faltante a PEDIDO, la confirmación no puede colarse.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(repo.lockMissingItemForUpdate).toHaveBeenCalledWith(tx, "missing-1");
    expect(repo.confirmMissingItem).toHaveBeenCalledWith(tx, {
      id: "missing-1",
      confirmedById: "admin-1",
      confirmedAt,
    });
  });

  it("is safe for already-confirmed and closed inventory statuses", async () => {
    const existingConfirmedAt = new Date("2026-07-01T10:00:00.000Z");
    repo.lockMissingItemForUpdate.mockResolvedValueOnce(
      missing({ confirmedAt: existingConfirmedAt, confirmedById: "older" }),
    );
    await expect(
      confirmMissingItemOk({ id: "missing-1", confirmedById: "admin-1" }),
    ).resolves.toEqual({
      item: expect.objectContaining({ confirmedAt: existingConfirmedAt }),
      changed: false,
    });

    repo.lockMissingItemForUpdate.mockResolvedValueOnce(missing({ status: "RECIBIDO" }));
    await expect(
      confirmMissingItemOk({ id: "missing-1", confirmedById: "admin-1" }),
    ).resolves.toEqual({
      item: expect.objectContaining({ status: "RECIBIDO" }),
      changed: false,
    });
    expect(repo.confirmMissingItem).toHaveBeenCalledTimes(0);
  });

  it("race: a concurrent order moved the item to PEDIDO with confirmedAt still null — confirming does not create PEDIDO + confirmedAt", async () => {
    // La carrera real: el pedido ganó el lock y dejó la fila en
    // PEDIDO + confirmedAt: null (orderMissingItem setea status=PEDIDO pero
    // NUNCA confirmedAt). La confirmación despierta, relee PEDIDO y debe salir
    // sin escribir — sin esto escribiría confirmedAt sobre un PEDIDO, produciendo
    // el estado imposible PEDIDO + confirmedAt.
    repo.lockMissingItemForUpdate.mockResolvedValue(
      missing({ status: "PEDIDO", confirmedAt: null }),
    );

    const result = await confirmMissingItemOk({ id: "missing-1", confirmedById: "admin-1" });

    expect(result.changed).toBe(false);
    expect(result.item.status).toBe("PEDIDO");
    expect(result.item.confirmedAt).toBeNull();
    expect(repo.confirmMissingItem).not.toHaveBeenCalled();
  });

  it("is safe for a PEDIDO that already has confirmedAt set (legacy/buggy state): does not reaffirm", async () => {
    // Estado históricamente posible pero inconsistente: un PEDIDO con
    // confirmedAt. La confirmación no debe tocar la fila.
    repo.lockMissingItemForUpdate.mockResolvedValue(
      missing({ status: "PEDIDO", confirmedAt: new Date("2026-07-01T10:00:00.000Z") }),
    );

    const result = await confirmMissingItemOk({ id: "missing-1", confirmedById: "admin-1" });

    expect(result.changed).toBe(false);
    expect(repo.confirmMissingItem).not.toHaveBeenCalled();
  });

  it("aborts the transaction when the compare-and-set writes no row", async () => {
    repo.lockMissingItemForUpdate.mockResolvedValue(missing());
    repo.confirmMissingItem.mockResolvedValue(0);

    await expect(
      confirmMissingItemOk({ id: "missing-1", confirmedById: "admin-1" }),
    ).rejects.toThrow(/concurrently/);
  });

  it("throws when the missing item does not exist", async () => {
    repo.lockMissingItemForUpdate.mockResolvedValue(null);

    await expect(
      confirmMissingItemOk({ id: "ghost", confirmedById: "admin-1" }),
    ).rejects.toThrow();
    expect(repo.confirmMissingItem).not.toHaveBeenCalled();
  });
});

describe("getMissingItems", () => {
  it("forwards cursor/take to listMissingItems and passes nextCursor through unchanged", async () => {
    const row = missingItemRow();
    repo.listMissingItems.mockResolvedValue({ items: [row], nextCursor: "cursor-abc" });

    const result = await getMissingItems({
      cursor: "cursor-in",
      take: 20,
      canViewCustomerIdentity: true,
    });

    expect(repo.listMissingItems).toHaveBeenCalledWith({
      cursor: "cursor-in",
      take: 20,
    });
    expect(result.nextCursor).toBe("cursor-abc");
  });

  it("nulls origin.customerName for every item when canViewCustomerIdentity is false, keeping every other field intact", async () => {
    const row = missingItemRow();
    repo.listMissingItems.mockResolvedValue({ items: [row], nextCursor: null });

    const result = await getMissingItems({ canViewCustomerIdentity: false });

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.origin?.customerName).toBeNull();
    expect(item).toEqual({
      ...row,
      origin: { ...row.origin, customerName: null },
    });
  });

  it("returns origin.customerName verbatim when canViewCustomerIdentity is true", async () => {
    const row = missingItemRow();
    repo.listMissingItems.mockResolvedValue({ items: [row], nextCursor: null });

    const result = await getMissingItems({ canViewCustomerIdentity: true });

    expect(result.items[0]!.origin?.customerName).toBe("Juan Pérez");
    expect(result.items[0]).toEqual(row);
  });

  it("passes items with origin === null through unchanged under both flags", async () => {
    const row = missingItemRow({ originId: null, origin: null });
    repo.listMissingItems.mockResolvedValue({ items: [row], nextCursor: null });

    const resultDenied = await getMissingItems({ canViewCustomerIdentity: false });
    expect(resultDenied.items[0]).toEqual(row);

    const resultAllowed = await getMissingItems({ canViewCustomerIdentity: true });
    expect(resultAllowed.items[0]).toEqual(row);
  });

  it("does not mutate the repository row in place when minimizing", async () => {
    const row = missingItemRow();
    repo.listMissingItems.mockResolvedValue({ items: [row], nextCursor: null });

    await getMissingItems({ canViewCustomerIdentity: false });

    // The object handed back by the mocked repo must still hold the
    // original customerName — the service must return NEW objects.
    expect(row.origin?.customerName).toBe("Juan Pérez");
  });
});

describe("createManualMissingItem", () => {
  it("creates a FALTANTE for an existing catalog product with originId null and note", async () => {
    productRepo.findProductById.mockResolvedValue({ id: "prod-1", active: true });
    repo.createMissingItem.mockResolvedValue({
      id: "missing-manual",
      productId: "prod-1",
      quantity: 3,
      originId: null,
      note: "Prioridad mostrador",
      status: "FALTANTE",
    });

    const result = await createManualMissingItem({
      productId: "prod-1",
      quantity: 3,
      note: "Prioridad mostrador",
      createdById: "admin-1",
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: "missing-manual",
        originId: null,
        note: "Prioridad mostrador",
      }),
    );
    expect(productRepo.findProductById).toHaveBeenCalledWith("prod-1");
    expect(repo.createMissingItem).toHaveBeenCalledWith({
      productId: "prod-1",
      quantity: 3,
      originId: null,
      createdById: "admin-1",
      note: "Prioridad mostrador",
    });
  });

  it("rejects unknown catalog product ids without creating a product or missing item", async () => {
    productRepo.findProductById.mockResolvedValue(null);

    await expect(
      createManualMissingItem({ productId: "ghost", quantity: 1, createdById: "admin-1" }),
    ).rejects.toThrow("Product not found");

    expect(repo.createMissingItem).not.toHaveBeenCalled();
  });
});

describe("getMissingItemsSummary", () => {
  const now = new Date("2026-07-09T10:00:00.000Z");

  // Los cuatro contadores alimentan la franja de chips de la cola operativa.
  // Son métricas GLOBALES: mezclarlas con las de la página paginada daría
  // números que no comparan entre sí.
  function mockCounts(
    counts: Partial<{
      open: number;
      overdue: number;
      ordered: number;
      confirmed: number;
    }> = {},
  ) {
    repo.countOpenMissingItems.mockResolvedValue(counts.open ?? 0);
    repo.countOverdueMissingItems.mockResolvedValue(counts.overdue ?? 0);
    repo.countOrderedMissingItems.mockResolvedValue(counts.ordered ?? 0);
    repo.countConfirmedMissingItems.mockResolvedValue(counts.confirmed ?? 0);
  }

  it("returns { open, overdue, ordered, confirmed } built from the repository counts", async () => {
    mockCounts({ open: 7, overdue: 2, ordered: 3, confirmed: 4 });

    await expect(getMissingItemsSummary(now)).resolves.toEqual({
      open: 7,
      overdue: 2,
      ordered: 3,
      confirmed: 4,
    });
  });

  it("propagates the injected `now` verbatim to countOverdueMissingItems", async () => {
    mockCounts();

    await getMissingItemsSummary(now);

    // Exact reference/value check: a stray `new Date()` inside the service
    // would not equal the injected `now` and must fail this assertion.
    expect(repo.countOverdueMissingItems).toHaveBeenCalledWith(now);
    expect(repo.countOverdueMissingItems).toHaveBeenCalledTimes(1);
  });

  it("calls the now-independent counts with no arguments", async () => {
    mockCounts();

    await getMissingItemsSummary(now);

    expect(repo.countOpenMissingItems).toHaveBeenCalledWith();
    expect(repo.countOpenMissingItems).toHaveBeenCalledTimes(1);
    expect(repo.countOrderedMissingItems).toHaveBeenCalledWith();
    expect(repo.countConfirmedMissingItems).toHaveBeenCalledWith();
  });

  it("runs every count concurrently, matching Promise.all semantics", async () => {
    const openDeferred = createDeferred<number>();
    const overdueDeferred = createDeferred<number>();
    repo.countOpenMissingItems.mockReturnValue(openDeferred.promise);
    repo.countOverdueMissingItems.mockReturnValue(overdueDeferred.promise);
    repo.countOrderedMissingItems.mockResolvedValue(0);
    repo.countConfirmedMissingItems.mockResolvedValue(0);

    const resultPromise = getMissingItemsSummary(now);

    // Every repository call must already have happened before either promise
    // resolves — a sequential `await a(); await b();` would only have invoked
    // the first one at this point.
    expect(repo.countOpenMissingItems).toHaveBeenCalledTimes(1);
    expect(repo.countOverdueMissingItems).toHaveBeenCalledTimes(1);
    expect(repo.countOrderedMissingItems).toHaveBeenCalledTimes(1);
    expect(repo.countConfirmedMissingItems).toHaveBeenCalledTimes(1);

    openDeferred.resolve(4);
    overdueDeferred.resolve(1);

    await expect(resultPromise).resolves.toEqual({
      open: 4,
      overdue: 1,
      ordered: 0,
      confirmed: 0,
    });
  });

  it("returns zeros without throwing when there are no missing items", async () => {
    mockCounts();

    await expect(getMissingItemsSummary(now)).resolves.toEqual({
      open: 0,
      overdue: 0,
      ordered: 0,
      confirmed: 0,
    });
  });

  it("returns overdue === open faithfully when every open item is overdue", async () => {
    mockCounts({ open: 5, overdue: 5 });

    await expect(getMissingItemsSummary(now)).resolves.toEqual({
      open: 5,
      overdue: 5,
      ordered: 0,
      confirmed: 0,
    });
  });
});

// Fila que devuelve `lockMissingItemForUpdate` para el flujo de pedido: `id`,
// `status`, `productId` y `confirmedAt` importan acá (este último es la señal
// de cierre que `orderMissingItem` debe respetar).
type OrderableRow = {
  id: string;
  status: MissingItemListItem["status"];
  productId: string;
  confirmedAt: Date | null;
};

function orderableRow(overrides: Partial<OrderableRow> = {}): OrderableRow {
  return {
    id: "missing-1",
    status: "FALTANTE",
    productId: "prod-1",
    confirmedAt: null,
    ...overrides,
  };
}

describe("orderMissingItem", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");

  beforeEach(() => {
    prismaMock.$transaction.mockImplementation(
      (fn: (client: typeof tx) => unknown) => fn(tx),
    );
  });

  it("orders a FALTANTE from an existing supplier: PEDIDO + orderedAt/by + supplierId", async () => {
    repo.lockMissingItemForUpdate.mockResolvedValue(orderableRow());
    supplierRepo.findSupplierById.mockResolvedValue({ id: "sup-1" });
    supplierRepo.upsertProductSupplierLink.mockResolvedValue(undefined);
    repo.orderMissingItem.mockResolvedValue(1);

    const result = await orderMissingItem(
      {
        missingItemId: "missing-1",
        userId: "admin-1",
        supplier: { kind: "existing", supplierId: "sup-1" },
      },
      now,
    );

    expect(result.rejection).toBeNull();
    expect(result.item).toEqual({
      id: "missing-1",
      status: "PEDIDO",
      orderedAt: now,
      supplierId: "sup-1",
    });
    // La escritura recibe el `tx`, el id, y `orderedAt === now` (inyectado).
    expect(repo.orderMissingItem).toHaveBeenCalledWith(tx, "missing-1", {
      supplierId: "sup-1",
      orderedById: "admin-1",
      orderedAt: now,
    });
    // El enlace producto↔proveedor se hace idempotente dentro de la misma tx.
    expect(supplierRepo.upsertProductSupplierLink).toHaveBeenCalledWith(tx, {
      productId: "prod-1",
      supplierId: "sup-1",
    });
  });

  it("returns ALREADY_ORDERED and writes nothing when the item is already PEDIDO", async () => {
    repo.lockMissingItemForUpdate.mockResolvedValue(orderableRow({ status: "PEDIDO" }));

    const result = await orderMissingItem(
      {
        missingItemId: "missing-1",
        userId: "admin-1",
        supplier: { kind: "existing", supplierId: "sup-1" },
      },
      now,
    );

    expect(result.item).toBeNull();
    expect(result.rejection).toBe("ALREADY_ORDERED");
    expect(repo.orderMissingItem).not.toHaveBeenCalled();
    expect(supplierRepo.upsertSupplierByName).not.toHaveBeenCalled();
    expect(supplierRepo.upsertProductSupplierLink).not.toHaveBeenCalled();
  });

  it("returns ALREADY_CONFIRMED and writes nothing when a FALTANTE item already has confirmedAt set", async () => {
    const confirmedAt = new Date("2026-07-08T09:00:00.000Z");
    repo.lockMissingItemForUpdate.mockResolvedValue(orderableRow({ confirmedAt }));

    const result = await orderMissingItem(
      {
        missingItemId: "missing-1",
        userId: "admin-1",
        supplier: { kind: "existing", supplierId: "sup-1" },
      },
      now,
    );

    expect(result.item).toBeNull();
    expect(result.rejection).toBe("ALREADY_CONFIRMED");
    // `confirmedAt` cierra el faltante aunque el status siga siendo FALTANTE
    // (form obsoleto/reenviado): ningún efecto de escritura debe correr.
    expect(repo.orderMissingItem).not.toHaveBeenCalled();
    expect(supplierRepo.findSupplierById).not.toHaveBeenCalled();
    expect(supplierRepo.upsertSupplierByName).not.toHaveBeenCalled();
    expect(supplierRepo.upsertProductSupplierLink).not.toHaveBeenCalled();
  });

  it("returns ALREADY_ORDERED (not ALREADY_CONFIRMED) when a PEDIDO item also has confirmedAt set — pins precedence", async () => {
    const confirmedAt = new Date("2026-07-08T09:00:00.000Z");
    repo.lockMissingItemForUpdate.mockResolvedValue(
      orderableRow({ status: "PEDIDO", confirmedAt }),
    );

    const result = await orderMissingItem(
      {
        missingItemId: "missing-1",
        userId: "admin-1",
        supplier: { kind: "existing", supplierId: "sup-1" },
      },
      now,
    );

    expect(result.item).toBeNull();
    expect(result.rejection).toBe("ALREADY_ORDERED");
    expect(repo.orderMissingItem).not.toHaveBeenCalled();
  });

  it("orders a FALTANTE with confirmedAt === null successfully (no regression)", async () => {
    repo.lockMissingItemForUpdate.mockResolvedValue(orderableRow({ confirmedAt: null }));
    supplierRepo.findSupplierById.mockResolvedValue({ id: "sup-1" });
    supplierRepo.upsertProductSupplierLink.mockResolvedValue(undefined);
    repo.orderMissingItem.mockResolvedValue(1);

    const result = await orderMissingItem(
      {
        missingItemId: "missing-1",
        userId: "admin-1",
        supplier: { kind: "existing", supplierId: "sup-1" },
      },
      now,
    );

    expect(result.rejection).toBeNull();
    expect(result.item?.status).toBe("PEDIDO");
  });

  it("locks the row on the tx client before resolving the supplier or writing", async () => {
    repo.lockMissingItemForUpdate.mockResolvedValue(orderableRow({ confirmedAt: null }));
    supplierRepo.findSupplierById.mockResolvedValue({ id: "sup-1" });
    supplierRepo.upsertProductSupplierLink.mockResolvedValue(undefined);
    repo.orderMissingItem.mockResolvedValue(1);

    await orderMissingItem(
      {
        missingItemId: "missing-1",
        userId: "admin-1",
        supplier: { kind: "existing", supplierId: "sup-1" },
      },
      now,
    );

    // El lock (incluida la lectura de confirmedAt) debe usar el cliente `tx`, no
    // el prisma default, y correr dentro del callback de `$transaction`.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(repo.lockMissingItemForUpdate).toHaveBeenCalledWith(tx, "missing-1");
    // El lock se toma ANTES de tocar proveedores: nada se escribe sobre un
    // faltante cuyo estado todavía no está congelado.
    expect(repo.lockMissingItemForUpdate.mock.invocationCallOrder[0]!).toBeLessThan(
      supplierRepo.findSupplierById.mock.invocationCallOrder[0]!,
    );
  });

  it("race: a concurrent manager already ordered the item — the second order is rejected and never overwrites the supplier", async () => {
    // La segunda transacción espera en el `FOR UPDATE` y, al despertar, lee el
    // PEDIDO que la primera acaba de confirmar. Sin el lock ambas habrían leído
    // FALTANTE y el último proveedor habría pisado al primero, dejando la
    // auditoría contradiciendo la realidad.
    repo.lockMissingItemForUpdate.mockResolvedValue(orderableRow({ status: "PEDIDO" }));

    const result = await orderMissingItem(
      {
        missingItemId: "missing-1",
        userId: "admin-2",
        supplier: { kind: "existing", supplierId: "sup-2" },
      },
      now,
    );

    expect(result.rejection).toBe("ALREADY_ORDERED");
    expect(result.item).toBeNull();
    expect(repo.orderMissingItem).not.toHaveBeenCalled();
    expect(supplierRepo.upsertProductSupplierLink).not.toHaveBeenCalled();
  });

  it("aborts the transaction when the compare-and-set writes no row", async () => {
    // Guarda de invariante: si el CAS no aplica, la transacción se revierte y
    // el proveedor creado al vuelo no queda huérfano.
    repo.lockMissingItemForUpdate.mockResolvedValue(orderableRow());
    supplierRepo.upsertSupplierByName.mockResolvedValue({ id: "sup-new" });
    supplierRepo.upsertProductSupplierLink.mockResolvedValue(undefined);
    repo.orderMissingItem.mockResolvedValue(0);

    await expect(
      orderMissingItem(
        {
          missingItemId: "missing-1",
          userId: "admin-1",
          supplier: { kind: "new", name: "Droguería Central" },
        },
        now,
      ),
    ).rejects.toThrow(/concurrently/);
  });

  it("returns NOT_ORDERABLE for RECIBIDO and CANCELADO items, writing nothing", async () => {
    for (const status of ["RECIBIDO", "CANCELADO"] as const) {
      vi.clearAllMocks();
      repo.lockMissingItemForUpdate.mockResolvedValue(orderableRow({ status }));

      const result = await orderMissingItem(
        {
          missingItemId: "missing-1",
          userId: "admin-1",
          supplier: { kind: "existing", supplierId: "sup-1" },
        },
        now,
      );

      expect(result.item).toBeNull();
      expect(result.rejection).toBe("NOT_ORDERABLE");
      expect(repo.orderMissingItem).not.toHaveBeenCalled();
    }
  });

  it("returns SUPPLIER_NOT_FOUND for an unknown existing supplier id, writing nothing", async () => {
    repo.lockMissingItemForUpdate.mockResolvedValue(orderableRow());
    supplierRepo.findSupplierById.mockResolvedValue(null);

    const result = await orderMissingItem(
      {
        missingItemId: "missing-1",
        userId: "admin-1",
        supplier: { kind: "existing", supplierId: "ghost" },
      },
      now,
    );

    expect(result.item).toBeNull();
    expect(result.rejection).toBe("SUPPLIER_NOT_FOUND");
    expect(supplierRepo.findSupplierById).toHaveBeenCalledWith("ghost", tx);
    expect(repo.orderMissingItem).not.toHaveBeenCalled();
    expect(supplierRepo.upsertProductSupplierLink).not.toHaveBeenCalled();
  });

  it("throws when the missing item does not exist (only case that throws)", async () => {
    repo.lockMissingItemForUpdate.mockResolvedValue(null);

    await expect(
      orderMissingItem(
        {
          missingItemId: "ghost",
          userId: "admin-1",
          supplier: { kind: "existing", supplierId: "sup-1" },
        },
        now,
      ),
    ).rejects.toThrow();
    expect(repo.orderMissingItem).not.toHaveBeenCalled();
  });

  it("new supplier: upserts by trimmed name (reuse, not error) and links the product", async () => {
    repo.lockMissingItemForUpdate.mockResolvedValue(orderableRow());
    supplierRepo.upsertSupplierByName.mockResolvedValue({ id: "sup-new" });
    supplierRepo.upsertProductSupplierLink.mockResolvedValue(undefined);
    repo.orderMissingItem.mockResolvedValue(1);

    const result = await orderMissingItem(
      {
        missingItemId: "missing-1",
        userId: "admin-1",
        supplier: {
          kind: "new",
          name: "  Droguería Central  ",
          phone: "555",
          email: "ventas@central.test",
        },
      },
      now,
    );

    expect(result.rejection).toBeNull();
    expect(result.item?.supplierId).toBe("sup-new");
    // El nombre único (recortado) ES la identidad: el upsert reutiliza el
    // proveedor existente con ese nombre en vez de fallar por la restricción.
    expect(supplierRepo.upsertSupplierByName).toHaveBeenCalledWith(tx, {
      name: "Droguería Central",
      phone: "555",
      address: null,
      email: "ventas@central.test",
    });
    expect(supplierRepo.upsertProductSupplierLink).toHaveBeenCalledWith(tx, {
      productId: "prod-1",
      supplierId: "sup-new",
    });
    expect(repo.orderMissingItem).toHaveBeenCalledWith(tx, "missing-1", {
      supplierId: "sup-new",
      orderedById: "admin-1",
      orderedAt: now,
    });
  });

  it("runs inside a single $transaction and uses the tx client for every repo read/write", async () => {
    repo.lockMissingItemForUpdate.mockResolvedValue(orderableRow());
    supplierRepo.findSupplierById.mockResolvedValue({ id: "sup-1" });
    supplierRepo.upsertProductSupplierLink.mockResolvedValue(undefined);
    repo.orderMissingItem.mockResolvedValue(1);

    await orderMissingItem(
      {
        missingItemId: "missing-1",
        userId: "admin-1",
        supplier: { kind: "existing", supplierId: "sup-1" },
      },
      now,
    );

    // El flujo entero corre en UNA transacción interactiva.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    // La relectura dentro de la tx es lo que cierra la carrera entre dos
    // gerentes pidiendo el mismo faltante: debe usar el `tx`, no el default.
    expect(repo.lockMissingItemForUpdate).toHaveBeenCalledWith(tx, "missing-1");
    expect(supplierRepo.findSupplierById).toHaveBeenCalledWith("sup-1", tx);
    expect(supplierRepo.upsertProductSupplierLink).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ productId: "prod-1", supplierId: "sup-1" }),
    );
    expect(repo.orderMissingItem).toHaveBeenCalledWith(
      tx,
      "missing-1",
      expect.objectContaining({ supplierId: "sup-1" }),
    );
  });

  it("never imports or calls any pending-repository function", async () => {
    repo.lockMissingItemForUpdate.mockResolvedValue(orderableRow());
    supplierRepo.findSupplierById.mockResolvedValue({ id: "sup-1" });
    supplierRepo.upsertProductSupplierLink.mockResolvedValue(undefined);
    repo.orderMissingItem.mockResolvedValue(1);

    await orderMissingItem(
      {
        missingItemId: "missing-1",
        userId: "admin-1",
        supplier: { kind: "existing", supplierId: "sup-1" },
      },
      now,
    );

    expect(pendingRepo.lockPendingForUpdate).not.toHaveBeenCalled();
    expect(pendingRepo.createPendingDelivery).not.toHaveBeenCalled();
    expect(pendingRepo.updatePendingAfterDelivery).not.toHaveBeenCalled();
    expect(pendingRepo.cancelPending).not.toHaveBeenCalled();
  });
});

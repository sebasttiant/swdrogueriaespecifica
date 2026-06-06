import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock del cliente Prisma: NO tocamos DB real. `$transaction` corre el callback
// con un `tx` falso y re-propaga si falla, igual que la transacción interactiva
// real — el rollback de la fila lo garantiza Prisma; acá verificamos que ambas
// escrituras viven en UNA sola transacción y que el error no se traga.
const { prismaMock, tx } = vi.hoisted(() => {
  const tx = {
    pending: { create: vi.fn() },
    missingItem: { create: vi.fn() },
    productBatch: { aggregate: vi.fn() },
  };
  const prismaMock = {
    $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  return { prismaMock, tx };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { registerPending } from "./pending.service";

const baseInput = {
  productId: "prod_1",
  quantity: 5,
  promisedAt: new Date("2026-06-09T14:30:00"),
  createdById: "user_1",
};

function mockStock(quantity: number) {
  tx.productBatch.aggregate.mockResolvedValue({ _sum: { quantity } });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(
    (fn: (client: typeof tx) => unknown) => fn(tx),
  );
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
});

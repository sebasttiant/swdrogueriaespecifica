import { describe, expect, it } from "vitest";

import { inventoryAdjustmentSchema } from "@/features/inventario/adjustment-schema";

describe("inventoryAdjustmentSchema", () => {
  const valid = {
    batchId: "batch-1",
    productId: "product-1",
    targetQuantity: "0",
    reason: "CAUSA_DESCONOCIDA",
    idempotencyKey: "ajuste-prueba-uno",
  };

  it("acepta un ajuste válido con nota vacía", () => {
    const parsed = inventoryAdjustmentSchema.safeParse({
      ...valid,
      note: "   ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.targetQuantity).toBe(0);
      expect(parsed.data.note).toBeUndefined();
    }
  });

  it("rechaza un motivo fuera de la lista", () => {
    const parsed = inventoryAdjustmentSchema.safeParse({
      ...valid,
      reason: "ROBO",
    });
    expect(parsed.success).toBe(false);
  });

  it("rechaza cantidad negativa", () => {
    const parsed = inventoryAdjustmentSchema.safeParse({
      ...valid,
      targetQuantity: "-1",
    });
    expect(parsed.success).toBe(false);
  });
});

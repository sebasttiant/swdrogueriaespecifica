import { describe, expect, it } from "vitest";

import {
  ADJUSTMENT_REASONS,
  isAdjustmentReason,
} from "@/features/inventario/adjustment-reason";

describe("isAdjustmentReason", () => {
  it.each([...ADJUSTMENT_REASONS])("acepta %s", (reason) => {
    expect(isAdjustmentReason(reason)).toBe(true);
  });

  it("rechaza un motivo inventado", () => {
    expect(isAdjustmentReason("ROBO")).toBe(false);
  });

  it("rechaza valores que no son texto", () => {
    expect(isAdjustmentReason(null)).toBe(false);
    expect(isAdjustmentReason(1)).toBe(false);
  });
});

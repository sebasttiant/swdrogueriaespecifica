import { describe, expect, it } from "vitest";

import {
  nextPendingStatus,
  remainingQuantity,
  validateCancellation,
  validateDelivery,
} from "./delivery-rules";

describe("remainingQuantity", () => {
  it("returns the difference when delivered is below quantity", () => {
    expect(remainingQuantity(10, 4)).toBe(6);
  });

  it("returns 0 when delivered equals quantity", () => {
    expect(remainingQuantity(10, 10)).toBe(0);
  });

  it("never goes negative when delivered exceeds quantity", () => {
    expect(remainingQuantity(10, 15)).toBe(0);
  });
});

describe("nextPendingStatus", () => {
  it("returns PENDIENTE when nothing has been delivered", () => {
    expect(nextPendingStatus(10, 0)).toBe("PENDIENTE");
  });

  it("returns PARCIAL when delivered is between 0 and quantity", () => {
    expect(nextPendingStatus(10, 1)).toBe("PARCIAL");
    expect(nextPendingStatus(10, 9)).toBe("PARCIAL");
  });

  it("returns ENTREGADO when delivered equals quantity", () => {
    expect(nextPendingStatus(10, 10)).toBe("ENTREGADO");
  });

  it("returns ENTREGADO when delivered exceeds quantity (defensive)", () => {
    expect(nextPendingStatus(10, 11)).toBe("ENTREGADO");
  });
});

describe("validateDelivery", () => {
  const base = {
    status: "PENDIENTE" as const,
    quantity: 10,
    deliveredQuantity: 4,
    deliverQuantity: 6,
  };

  it("rejects ALREADY_DELIVERED when status is ENTREGADO", () => {
    expect(
      validateDelivery({ ...base, status: "ENTREGADO", deliveredQuantity: 10, deliverQuantity: 1 }),
    ).toBe("ALREADY_DELIVERED");
  });

  it("rejects ALREADY_CANCELLED when status is CANCELADO", () => {
    expect(validateDelivery({ ...base, status: "CANCELADO" })).toBe("ALREADY_CANCELLED");
  });

  it("rejects NON_POSITIVE_QUANTITY when deliverQuantity is 0", () => {
    expect(validateDelivery({ ...base, deliverQuantity: 0 })).toBe("NON_POSITIVE_QUANTITY");
  });

  it("rejects NON_POSITIVE_QUANTITY when deliverQuantity is -1", () => {
    expect(validateDelivery({ ...base, deliverQuantity: -1 })).toBe("NON_POSITIVE_QUANTITY");
  });

  it("rejects NON_POSITIVE_QUANTITY when deliverQuantity is fractional", () => {
    expect(validateDelivery({ ...base, deliverQuantity: 1.5 })).toBe("NON_POSITIVE_QUANTITY");
  });

  it("rejects EXCEEDS_REMAINING when deliverQuantity is remaining + 1", () => {
    // remaining = 10 - 4 = 6, so 7 must be rejected
    expect(validateDelivery({ ...base, deliverQuantity: 7 })).toBe("EXCEEDS_REMAINING");
  });

  it("allows deliverQuantity exactly equal to remaining", () => {
    // remaining = 10 - 4 = 6
    expect(validateDelivery({ ...base, deliverQuantity: 6 })).toBeNull();
  });

  it("allows a partial delivery within remaining", () => {
    expect(validateDelivery({ ...base, deliverQuantity: 3 })).toBeNull();
  });

  it("allows a PARCIAL pending to be delivered further", () => {
    expect(
      validateDelivery({ status: "PARCIAL", quantity: 10, deliveredQuantity: 4, deliverQuantity: 6 }),
    ).toBeNull();
  });
});

describe("validateCancellation", () => {
  it("rejects ALREADY_DELIVERED when status is ENTREGADO", () => {
    expect(validateCancellation("ENTREGADO")).toBe("ALREADY_DELIVERED");
  });

  it("rejects ALREADY_CANCELLED when status is CANCELADO", () => {
    expect(validateCancellation("CANCELADO")).toBe("ALREADY_CANCELLED");
  });

  it("allows cancellation when status is PENDIENTE", () => {
    expect(validateCancellation("PENDIENTE")).toBeNull();
  });

  it("allows cancellation when status is PARCIAL", () => {
    expect(validateCancellation("PARCIAL")).toBeNull();
  });
});

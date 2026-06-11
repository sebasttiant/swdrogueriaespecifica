import { describe, expect, it } from "vitest";

import {
  MIN_PRODUCT_QUERY_LENGTH,
  prepareProductQuery,
} from "./search-query";

describe("prepareProductQuery", () => {
  it("returns null for an empty or whitespace-only query", () => {
    expect(prepareProductQuery("")).toBeNull();
    expect(prepareProductQuery("   ")).toBeNull();
  });

  it("returns null for queries shorter than the minimum length", () => {
    expect(prepareProductQuery("a")).toBeNull();
    // A single non-space char surrounded by spaces is still below the minimum.
    expect(prepareProductQuery("  x  ")).toBeNull();
  });

  it("trims and returns queries that meet the minimum length", () => {
    expect(prepareProductQuery("ab")).toBe("ab");
    expect(prepareProductQuery("  paracetamol  ")).toBe("paracetamol");
  });

  it("exposes a minimum length of 2", () => {
    expect(MIN_PRODUCT_QUERY_LENGTH).toBe(2);
  });
});

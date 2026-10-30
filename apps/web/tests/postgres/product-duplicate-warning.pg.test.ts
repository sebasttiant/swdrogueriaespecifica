import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { findProductNameCandidates } from "@/server/services/product.service";

const run = `${Date.now()}-${process.pid}`;
const createdIds: string[] = [];

async function createProduct(name: string, suffix: string) {
  const product = await prisma.product.create({
    data: {
      code: `DUP-WARN-${run}-${suffix}`,
      name,
      unit: "Caja",
      minStock: 0,
      reorderQty: 0,
    },
  });
  createdIds.push(product.id);
  return product;
}

afterAll(async () => {
  if (createdIds.length > 0) {
    await prisma.product.deleteMany({ where: { id: { in: createdIds } } });
  }
  await prisma.$disconnect();
});

describe("catalog product duplicate warning", () => {
  it("finds the same conservative name across case, spaces, and NFC", async () => {
    const composed = `VALCOTÉ   ER ${run}`;
    const existing = await createProduct(composed, "existing");
    const decomposed = `  valcoté er ${run}  `;

    const candidates = await findProductNameCandidates(decomposed);

    expect(candidates).toEqual([
      expect.objectContaining({ id: existing.id, code: existing.code }),
    ]);
  });

  it("finds an existing catalog name written with a non-breaking space", async () => {
    const existing = await createProduct(`VALCOTE\u00a0ER NBSP ${run}`, "nbsp");

    const candidates = await findProductNameCandidates(`valcote er nbsp ${run}`);

    expect(candidates).toEqual([expect.objectContaining({ id: existing.id })]);
  });

  it("does not merge a different presentation", async () => {
    await createProduct(`VALCOTE ER ${run} CAJA X 30`, "x30");

    const candidates = await findProductNameCandidates(
      `VALCOTE ER ${run} CAJA X 60`,
    );

    expect(candidates).toEqual([]);
  });
});

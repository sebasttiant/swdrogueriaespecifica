import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  ManualProductNameConflictError,
  registerPending,
} from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// October 2026 incident: the same product was captured several times as a
// manual product, leaving indistinguishable `MAN-*` rows that the warehouse
// could not receive. The rule is enforced by the unique index on
// `provisionalNormalizedName`, so it is tested against real PostgreSQL: two
// simultaneous captures race for the same key and only one may win.
//
// The rule is deliberately CONSERVATIVE: it only collapses the same name after
// Unicode, case and whitespace normalization. Different presentations stay
// different products, because merging them would be a catalog decision this
// capture screen is not allowed to take.
// --------------------------------------------------------------------------

let actorId = "";
let createdNames: string[] = [];

beforeAll(async () => {
  const actor = await prisma.user.create({
    data: { email: `manual-dup-${Date.now()}@test.local`, name: "Manual duplicate actor" },
  });
  actorId = actor.id;
});

afterEach(async () => {
  const products = await prisma.product.findMany({
    where: { name: { in: createdNames } },
    select: { id: true },
  });
  const productIds = products.map((product) => product.id);
  if (productIds.length > 0) {
    await prisma.missingItem.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.pending.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  }
  createdNames = [];
});

function manualCapture(name: string) {
  createdNames.push(name.trim());
  return {
    createdById: actorId,
    quantity: 1,
    idempotencyKey: randomUUID(),
    promisedAt: new Date("2030-01-01T00:00:00.000Z"),
    customerName: "Ana Pérez",
    customerPhone: "3001234567",
    manual: { name, unit: "unidad" },
  };
}

describe("manual product duplicates", () => {
  it("stores the normalized provisional identity of the created product", async () => {
    const name = `SEDATIF PC X 40 TABLETAS ${Date.now()}`;
    const result = await registerPending(manualCapture(name));

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: result.createdProduct?.id ?? "" },
    });
    expect(product.provisionalNormalizedName).toBe(name.toLowerCase());
    expect(product.needsReview).toBe(true);
  });

  it("rejects a second capture of the same name instead of creating another product", async () => {
    const name = `Duplicado exacto ${Date.now()}`;
    const first = await registerPending(manualCapture(name));

    await expect(registerPending(manualCapture(`  ${name.toUpperCase()}  `)))
      .rejects.toBeInstanceOf(ManualProductNameConflictError);

    const products = await prisma.product.findMany({ where: { name: name.trim() } });
    expect(products).toHaveLength(1);
    expect(products[0]?.id).toBe(first.createdProduct?.id);
  });

  it("lets only one of two simultaneous captures create the product", async () => {
    const name = `Carrera manual ${Date.now()}`;
    const results = await Promise.allSettled([
      registerPending(manualCapture(name)),
      registerPending(manualCapture(name)),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ManualProductNameConflictError,
    );

    expect(
      await prisma.product.count({
        where: { provisionalNormalizedName: name.toLowerCase() },
      }),
    ).toBe(1);
  });

  it("keeps different presentations as different products", async () => {
    const stamp = Date.now();
    const first = await registerPending(manualCapture(`Sedatif PC x 40 tabletas ${stamp}`));
    const second = await registerPending(manualCapture(`Sedatif PC x 60 tabletas ${stamp}`));

    expect(first.createdProduct?.id).not.toBe(second.createdProduct?.id);
  });
});

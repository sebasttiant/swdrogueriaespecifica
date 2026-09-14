import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  claimableStockForPending,
  countExpiringBatches,
  listBatchesByProduct,
  stockByProduct,
} from "@/server/repositories/product-batch.repository";

// --------------------------------------------------------------------------
// Un vencimiento DESCONOCIDO no hace desaparecer stock.
//
// `expiresAt` acepta NULL desde la migración
// `20260912000000_product_batch_expiry_optional`. NULL es DESCONOCIDO, no
// vencido, y esa diferencia la decide SQL: una comparación contra NULL nunca es
// verdadera, así que cualquier consulta con `"expiresAt" > now` deja esa
// mercadería afuera aunque esté en el estante. Por eso las lecturas de stock
// llevan el `OR ... IS NULL` explícito.
//
// Y al revés en los avisos: un lote sin fecha no entra en ninguna franja de
// vencimiento, porque nadie sabe cuándo vence y no hay nada que anunciar.
// --------------------------------------------------------------------------

let productId = "";
const RUN = randomUUID().slice(0, 6);

const AHORA = new Date("2026-09-12T17:00:00.000Z"); // 12:00 Bogotá
const PRONTO = new Date("2026-10-01T05:00:00.000Z"); // vence en ~19 días
const LEJANO = new Date("2028-01-01T05:00:00.000Z");

beforeAll(async () => {
  const product = await prisma.product.create({
    data: {
      orionCode: `ORN-NUL-${Date.now()}`,
      code: `NUL-${Date.now()}`,
      name: `Suero fisiológico ${RUN}`,
      unit: "frasco",
    },
  });
  productId = product.id;
});

afterEach(async () => {
  await prisma.productBatch.deleteMany({ where: { productId } });
});

function lote(batchCode: string, expiresAt: Date | null, quantity: number) {
  return prisma.productBatch.create({
    data: { productId, batchCode, expiresAt, quantity, status: "DISPONIBLE" },
  });
}

// --------------------------------------------------------------------------
// 3. El lote sin fecha es stock vendible y reclamable.
// --------------------------------------------------------------------------
describe("stock de un lote SIN vencimiento", () => {
  it("stockByProduct lo cuenta", async () => {
    await lote(`SIN-FECHA-${RUN}`, null, 7);

    expect(await stockByProduct(productId, AHORA)).toBe(7);
  });

  it("lo suma junto con los lotes que sí tienen fecha", async () => {
    await lote(`SIN-FECHA-${RUN}`, null, 7);
    await lote(`CON-FECHA-${RUN}`, LEJANO, 3);

    expect(await stockByProduct(productId, AHORA)).toBe(10);
  });

  // Lo desconocido no vuelve vendible lo que no lo es por otra razón.
  it("no lo cuenta si está agotado o retenido", async () => {
    await lote(`AGOTADO-${RUN}`, null, 0);
    await prisma.productBatch.create({
      data: {
        productId,
        batchCode: `RETENIDO-${RUN}`,
        expiresAt: null,
        quantity: 5,
        status: "RETENIDO",
      },
    });

    expect(await stockByProduct(productId, AHORA)).toBe(0);
  });

  it("claimableStockForPending lo puede reclamar", async () => {
    await lote(`SIN-FECHA-${RUN}`, null, 7);

    const reclamable = await prisma.$transaction((tx) =>
      claimableStockForPending(tx, productId, 5, AHORA),
    );

    expect(reclamable).toBe(5);
  });

  it("no reclama más de lo que hay", async () => {
    await lote(`SIN-FECHA-${RUN}`, null, 2);

    const reclamable = await prisma.$transaction((tx) =>
      claimableStockForPending(tx, productId, 5, AHORA),
    );

    expect(reclamable).toBe(2);
  });

  // Un lote VENCIDO sigue fuera del stock: la regla que se relajó es la del
  // dato ausente, no la del vencimiento cumplido.
  it("un lote vencido sigue sin contar", async () => {
    await lote(`VENCIDO-${RUN}`, new Date("2025-01-01T05:00:00.000Z"), 9);

    expect(await stockByProduct(productId, AHORA)).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Lo desconocido no es un aviso de vencimiento.
// --------------------------------------------------------------------------
describe("avisos de vencimiento", () => {
  it("un lote sin fecha no entra en NINGUNA franja", async () => {
    await lote(`SIN-FECHA-${RUN}`, null, 7);

    expect(await countExpiringBatches(AHORA)).toEqual({
      expired: 0,
      critical: 0,
      warning: 0,
    });
  });

  it("y no tapa al que sí está por vencer", async () => {
    await lote(`SIN-FECHA-${RUN}`, null, 7);
    await lote(`PRONTO-${RUN}`, PRONTO, 3);

    expect(await countExpiringBatches(AHORA)).toEqual({
      expired: 0,
      critical: 1,
      warning: 0,
    });
  });
});

// --------------------------------------------------------------------------
// 4. FEFO: lo que vence antes sale primero, y lo desconocido va AL FINAL.
//
// No hace falta cambiar nada para esto: `ORDER BY ... ASC` en PostgreSQL es
// NULLS LAST. Estas pruebas lo VERIFICAN en vez de asumirlo, en las dos formas
// en que el orden se pide: por Prisma (con `nulls: "last"` escrito, que es el
// mismo default) y en el SQL crudo que bloquea las filas.
// --------------------------------------------------------------------------
describe("orden FEFO con vencimientos desconocidos", () => {
  it("el listado por producto pone el que vence antes primero y el sin fecha al final", async () => {
    await lote(`C-SIN-FECHA-${RUN}`, null, 1);
    await lote(`A-LEJANO-${RUN}`, LEJANO, 1);
    await lote(`B-PRONTO-${RUN}`, PRONTO, 1);

    const { items } = await listBatchesByProduct({ productId });

    expect(items.map((item) => item.batchCode)).toEqual([
      `B-PRONTO-${RUN}`,
      `A-LEJANO-${RUN}`,
      `C-SIN-FECHA-${RUN}`,
    ]);
  });

  it("el SQL crudo que bloquea las filas también deja los NULL al final", async () => {
    await lote(`C-SIN-FECHA-${RUN}`, null, 1);
    await lote(`A-LEJANO-${RUN}`, LEJANO, 1);
    await lote(`B-PRONTO-${RUN}`, PRONTO, 1);

    // El MISMO orden que usa `claimableStockForPending`, sin el `FOR UPDATE`
    // (que exigiría transacción y no cambia el orden).
    const filas = await prisma.$queryRaw<{ batchCode: string }[]>`
      SELECT "batchCode" FROM product_batches
      WHERE "productId" = ${productId} AND status = 'DISPONIBLE'
        AND quantity > 0 AND ("expiresAt" IS NULL OR "expiresAt" > ${AHORA})
      ORDER BY "expiresAt" ASC, id ASC
    `;

    expect(filas.map((fila) => fila.batchCode)).toEqual([
      `B-PRONTO-${RUN}`,
      `A-LEJANO-${RUN}`,
      `C-SIN-FECHA-${RUN}`,
    ]);
  });
});

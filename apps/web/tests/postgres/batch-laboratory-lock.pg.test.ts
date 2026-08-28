import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { lockBatchLaboratoryEvidence } from "@/server/repositories/product-batch.repository";

// --------------------------------------------------------------------------
// La carrera de la PRIMERA recepción de un lote.
//
// `SELECT ... FOR UPDATE` bloquea FILAS, y una fila que todavía no existe no se
// puede bloquear. Dos primeras recepciones simultáneas del mismo
// `(productId, batchCode)` leían ambas `null`, las dos se creían la primera, y
// si traían laboratorios distintos la segunda pisaba la evidencia de la primera
// en silencio — justo lo que la regla de conflicto existe para impedir.
//
// El lock de fila sigue siendo correcto para el lote que YA existe. Lo que
// faltaba era serializar el hueco previo a que la fila exista, y para eso el
// candado no puede colgar de la fila: cuelga del PAR que la identifica, con un
// advisory lock transaccional.
//
// Estas pruebas necesitan concurrencia DE VERDAD: `Promise.all` sobre dos
// transacciones no demuestra nada por sí solo, porque nada garantiza que se
// solapen. Acá la segunda transacción no puede avanzar hasta que la primera
// tomó el candado, y la primera no confirma hasta que la segunda ya intentó
// tomarlo. Sin esas dos barreras la prueba pasa aunque el candado no exista.
// --------------------------------------------------------------------------

let productId = "";
const BATCH = `LOTE-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `LCK-${Date.now()}`, name: "Ibuprofeno 400mg", unit: "caja" },
  });
  productId = product.id;
});

afterEach(async () => {
  await prisma.productBatch.deleteMany({ where: { productId } });
});

/** Una promesa que se resuelve desde afuera. */
function barrera(): { esperar: Promise<void>; abrir: () => void } {
  let abrir!: () => void;
  const esperar = new Promise<void>((resolve) => {
    abrir = resolve;
  });
  return { esperar, abrir };
}

describe("lockBatchLaboratoryEvidence · el lote todavía no existe", () => {
  it("serializa dos primeras recepciones simultáneas del mismo lote", async () => {
    const primeraTomo = barrera();
    const segundaIntento = barrera();
    const orden: string[] = [];

    const primera = prisma.$transaction(async (tx) => {
      await lockBatchLaboratoryEvidence(tx, { productId, batchCode: BATCH });
      orden.push("A tomó el candado");
      primeraTomo.abrir();

      // No confirma hasta que la segunda YA intentó tomarlo. Sin esto, la
      // primera podría terminar antes de que la segunda arranque y la prueba
      // pasaría sin haber probado nada.
      await segundaIntento.esperar;

      await tx.productBatch.create({
        data: {
          productId,
          batchCode: BATCH,
          expiresAt: new Date("2027-01-01T00:00:00Z"),
          quantity: 1,
        },
      });
      orden.push("A confirmó");
    });

    const segunda = (async () => {
      await primeraTomo.esperar;
      const t = prisma.$transaction(async (tx) => {
        orden.push("B pide el candado");
        segundaIntento.abrir();
        const visto = await lockBatchLaboratoryEvidence(tx, {
          productId,
          batchCode: BATCH,
        });
        orden.push("B tomó el candado");
        return visto;
      });
      return t;
    })();

    const [, vistoPorB] = await Promise.all([primera, segunda]);

    // Lo que importa: B no pudo pasar el candado hasta que A confirmó, así que
    // ve el lote que A creó en vez de creerse la primera.
    expect(orden.indexOf("A confirmó")).toBeLessThan(
      orden.indexOf("B tomó el candado"),
    );
    expect(vistoPorB).not.toBeNull();
    expect(await prisma.productBatch.count({ where: { productId } })).toBe(1);
  });

  it("dos lotes DISTINTOS no se bloquean entre sí", async () => {
    const otroLote = `${BATCH}-OTRO`;
    const aTomo = barrera();

    const a = prisma.$transaction(async (tx) => {
      await lockBatchLaboratoryEvidence(tx, { productId, batchCode: BATCH });
      aTomo.abrir();
      // Se queda adentro mientras B trabaja: si el candado fuera global, B se
      // colgaría acá y la prueba se iría en timeout.
      await new Promise((r) => setTimeout(r, 300));
    });

    const b = (async () => {
      await aTomo.esperar;
      return prisma.$transaction(async (tx) =>
        lockBatchLaboratoryEvidence(tx, { productId, batchCode: otroLote }),
      );
    })();

    // Si B tuviera que esperar a A, esto tardaría los 300ms completos.
    const inicio = Date.now();
    await Promise.all([a, b]);
    const bTerminoAntes = Date.now() - inicio;

    expect(bTerminoAntes).toBeLessThan(3_000);
  });

  it("el candado se suelta al terminar la transacción", async () => {
    await prisma.$transaction(async (tx) => {
      await lockBatchLaboratoryEvidence(tx, { productId, batchCode: BATCH });
    });

    // Si el advisory lock fuera de sesión y no transaccional, esta segunda
    // toma se colgaría para siempre sobre el mismo pool.
    const segunda = await prisma.$transaction(async (tx) =>
      lockBatchLaboratoryEvidence(tx, { productId, batchCode: BATCH }),
    );

    expect(segunda).toBeNull();
  });

  it("el lote que YA existe sigue devolviendo su evidencia", async () => {
    const lab = await prisma.laboratory.create({ data: { name: `Lab ${BATCH}` } });
    await prisma.productBatch.create({
      data: {
        productId,
        batchCode: BATCH,
        expiresAt: new Date("2027-01-01T00:00:00Z"),
        quantity: 5,
        receivedLaboratoryId: lab.id,
      },
    });

    const visto = await prisma.$transaction(async (tx) =>
      lockBatchLaboratoryEvidence(tx, { productId, batchCode: BATCH }),
    );

    expect(visto?.receivedLaboratoryId).toBe(lab.id);
    expect(visto?.receivedLaboratoryName).toBe(`Lab ${BATCH}`);
  });
});

import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { deriveReservedBatchCode } from "@/lib/inventory/reserved-batch-code";
import {
  BatchExpiryConflictError,
  registerInventoryEntry,
} from "@/server/services/inventory-entry.service";

// --------------------------------------------------------------------------
// El lote y el vencimiento son opcionales, y NINGÚN vencimiento se hereda.
//
// Se prueba contra PostgreSQL real porque lo que se afirma son propiedades de
// la base: que dos recepciones sin lote y con fechas distintas terminen en DOS
// filas, que un conflicto de vencimiento revierta la transacción ENTERA, y que
// dos recepciones simultáneas del mismo lote nuevo no pasen las dos. Nada de
// eso lo decide el código: lo decide la clave única, la transacción y el
// candado.
// --------------------------------------------------------------------------

let productId = "";
const RUN = randomUUID().slice(0, 6);

const ENERO = new Date("2027-01-15T05:00:00.000Z"); // 00:00 Bogotá del 15/1
const MARZO = new Date("2027-03-20T05:00:00.000Z");

beforeAll(async () => {
  const product = await prisma.product.create({
    data: {
      orionCode: `ORN-VNC-${Date.now()}`,
      code: `VNC-${Date.now()}`,
      name: `Amoxicilina 500mg ${RUN}`,
      unit: "caja",
    },
  });
  productId = product.id;
});

afterEach(async () => {
  await prisma.inventoryAllocation.deleteMany({ where: { inventoryEntry: { productId } } });
  await prisma.inventoryEntry.deleteMany({ where: { productId } });
  await prisma.productBatch.deleteMany({ where: { productId } });
});

/** Una recepción, con clave de idempotencia propia salvo que se pida otra. */
function recepcion(overrides: Record<string, unknown> = {}) {
  return {
    productId,
    quantity: 5,
    expiresAt: ENERO,
    createdById: null,
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

function lotes() {
  return prisma.productBatch.findMany({
    where: { productId },
    orderBy: { batchCode: "asc" },
    select: { batchCode: true, expiresAt: true, quantity: true },
  });
}

// --------------------------------------------------------------------------
// 1. Dos cajas SIN lote con vencimientos distintos son DOS lotes.
//
// Es la razón por la que el código reservado lleva la fecha adentro. Con un
// único "SIN LOTE" para todo, la segunda caja caería en la fila de la primera y
// heredaría su vencimiento: el stock quedaría junto bajo una fecha que no le
// corresponde a la mitad.
// --------------------------------------------------------------------------
describe("recepción sin lote", () => {
  it("dos vencimientos distintos dejan DOS filas, cada una con su fecha", async () => {
    await registerInventoryEntry(recepcion({ quantity: 5, expiresAt: ENERO }));
    await registerInventoryEntry(recepcion({ quantity: 3, expiresAt: MARZO }));

    expect(await lotes()).toEqual([
      { batchCode: "SIN LOTE 2027-01-15", expiresAt: ENERO, quantity: 5 },
      { batchCode: "SIN LOTE 2027-03-20", expiresAt: MARZO, quantity: 3 },
    ]);
  });

  it("sin vencimiento guarda la forma pelada y la fecha en NULL", async () => {
    await registerInventoryEntry(recepcion({ quantity: 7, expiresAt: null }));

    expect(await lotes()).toEqual([
      { batchCode: "SIN LOTE", expiresAt: null, quantity: 7 },
    ]);
  });

  it("dos cajas sin lote con el MISMO vencimiento suman en una fila", async () => {
    await registerInventoryEntry(recepcion({ quantity: 5, expiresAt: ENERO }));
    await registerInventoryEntry(recepcion({ quantity: 4, expiresAt: ENERO }));

    expect(await lotes()).toEqual([
      { batchCode: deriveReservedBatchCode(ENERO), expiresAt: ENERO, quantity: 9 },
    ]);
  });

  // Sin lote y con fecha es un lote distinto de sin lote y sin fecha: no se
  // pueden mezclar, porque uno dice cuándo vence y el otro no lo sabe.
  it("con fecha y sin fecha son dos lotes distintos", async () => {
    await registerInventoryEntry(recepcion({ quantity: 5, expiresAt: ENERO }));
    await registerInventoryEntry(recepcion({ quantity: 2, expiresAt: null }));

    expect(await lotes()).toEqual([
      { batchCode: "SIN LOTE", expiresAt: null, quantity: 2 },
      { batchCode: "SIN LOTE 2027-01-15", expiresAt: ENERO, quantity: 5 },
    ]);
  });
});

// --------------------------------------------------------------------------
// 2. Un lote REAL no cambia de vencimiento.
//
// `upsertBatchQuantity` identifica el lote por `(productId, batchCode)` y en la
// rama de actualización incrementa la cantidad sin tocar `expiresAt`. Las dos
// alternativas silenciosas —conservar la fecha vieja o pisarla— dejan stock
// mezclado bajo una fecha que no le corresponde a una parte. Se rechaza.
// --------------------------------------------------------------------------
describe("lote real · el vencimiento no se hereda ni se pierde", () => {
  const LOTE = `L-${RUN}`;

  async function filaDelLote() {
    return prisma.productBatch.findFirstOrThrow({
      where: { productId, batchCode: LOTE },
      select: { batchCode: true, expiresAt: true, quantity: true },
    });
  }

  it("de una fecha conocida a NINGUNA: rechaza y la fila no cambia", async () => {
    await registerInventoryEntry(
      recepcion({ batchCode: LOTE, quantity: 5, expiresAt: ENERO }),
    );

    await expect(
      registerInventoryEntry(
        recepcion({ batchCode: LOTE, quantity: 9, expiresAt: null }),
      ),
    ).rejects.toBeInstanceOf(BatchExpiryConflictError);

    expect(await filaDelLote()).toEqual({
      batchCode: LOTE,
      expiresAt: ENERO,
      quantity: 5,
    });
  });

  it("de NINGUNA fecha a una conocida: rechaza y la fila sigue en NULL", async () => {
    await registerInventoryEntry(
      recepcion({ batchCode: LOTE, quantity: 5, expiresAt: null }),
    );

    await expect(
      registerInventoryEntry(
        recepcion({ batchCode: LOTE, quantity: 9, expiresAt: ENERO }),
      ),
    ).rejects.toBeInstanceOf(BatchExpiryConflictError);

    expect(await filaDelLote()).toEqual({
      batchCode: LOTE,
      expiresAt: null,
      quantity: 5,
    });
  });

  it("dos fechas distintas: rechaza y conserva la primera", async () => {
    await registerInventoryEntry(
      recepcion({ batchCode: LOTE, quantity: 5, expiresAt: ENERO }),
    );

    await expect(
      registerInventoryEntry(
        recepcion({ batchCode: LOTE, quantity: 9, expiresAt: MARZO }),
      ),
    ).rejects.toBeInstanceOf(BatchExpiryConflictError);

    expect(await filaDelLote()).toEqual({
      batchCode: LOTE,
      expiresAt: ENERO,
      quantity: 5,
    });
  });

  // El rechazo tiene que llevarse la transacción ENTERA: si quedara la fila de
  // ledger, el inventario diría que entró mercadería que no entró.
  it("el rechazo no deja fila de ledger", async () => {
    await registerInventoryEntry(
      recepcion({ batchCode: LOTE, quantity: 5, expiresAt: ENERO }),
    );

    await expect(
      registerInventoryEntry(
        recepcion({ batchCode: LOTE, quantity: 9, expiresAt: MARZO }),
      ),
    ).rejects.toBeInstanceOf(BatchExpiryConflictError);

    expect(await prisma.inventoryEntry.count({ where: { productId } })).toBe(1);
  });

  it("la MISMA fecha suma la cantidad en una sola fila", async () => {
    await registerInventoryEntry(
      recepcion({ batchCode: LOTE, quantity: 5, expiresAt: ENERO }),
    );
    await registerInventoryEntry(
      recepcion({ batchCode: LOTE, quantity: 4, expiresAt: ENERO }),
    );

    expect(await filaDelLote()).toEqual({
      batchCode: LOTE,
      expiresAt: ENERO,
      quantity: 9,
    });
    expect(await prisma.productBatch.count({ where: { productId } })).toBe(1);
  });

  // El mensaje se le muestra a la persona que tiene la caja delante: lleva el
  // código de lote y la fecha ya registrada, nunca un id interno.
  it("el error nombra el lote y la fecha registrada", async () => {
    await registerInventoryEntry(
      recepcion({ batchCode: LOTE, quantity: 5, expiresAt: ENERO }),
    );

    let error: unknown;
    try {
      await registerInventoryEntry(
        recepcion({ batchCode: LOTE, quantity: 9, expiresAt: MARZO }),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BatchExpiryConflictError);
    const conflicto = error as BatchExpiryConflictError;
    expect(conflicto.batchCode).toBe(LOTE);
    expect(conflicto.existingExpiresAt).toEqual(ENERO);
  });
});

// --------------------------------------------------------------------------
// 5. Dos recepciones SIMULTÁNEAS del mismo lote nuevo.
//
// Una lectura y después una escritura es una carrera: las dos transacciones
// leerían que el lote todavía no existe, las dos se creerían la primera, y la
// segunda pisaría o heredaría la fecha de la primera en silencio. El candado es
// un advisory lock TRANSACCIONAL sobre el par `(productId, batchCode)`, que
// existe aunque la fila no exista.
//
// Lo que se afirma: exactamente UNA pasa, la otra se rechaza, y no queda
// ninguna fila de ledger a medias.
// --------------------------------------------------------------------------
describe("dos recepciones simultáneas del mismo lote nuevo", () => {
  it("con fechas distintas, exactamente una pasa y no queda nada a medias", async () => {
    const LOTE = `L-CONC-${RUN}`;

    // Las dos promesas se crean ANTES de esperar ninguna: arrancan las dos
    // contra el pool y se solapan de verdad.
    const primera = registerInventoryEntry(
      recepcion({ batchCode: LOTE, quantity: 5, expiresAt: ENERO }),
    );
    const segunda = registerInventoryEntry(
      recepcion({ batchCode: LOTE, quantity: 9, expiresAt: MARZO }),
    );

    const resultados = await Promise.allSettled([primera, segunda]);
    const cumplidas = resultados.filter((r) => r.status === "fulfilled");
    const rechazadas = resultados.filter((r) => r.status === "rejected");

    expect(cumplidas).toHaveLength(1);
    expect(rechazadas).toHaveLength(1);
    expect((rechazadas[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      BatchExpiryConflictError,
    );

    // Una sola fila, con la fecha y la cantidad de la que ganó. Y una sola fila
    // de ledger: la rechazada no dejó rastro.
    const filas = await prisma.productBatch.findMany({
      where: { productId, batchCode: LOTE },
      select: { expiresAt: true, quantity: true },
    });
    expect(filas).toHaveLength(1);
    expect([5, 9]).toContain(filas[0]!.quantity);
    expect([ENERO.getTime(), MARZO.getTime()]).toContain(
      filas[0]!.expiresAt!.getTime(),
    );
    expect(await prisma.inventoryEntry.count({ where: { productId } })).toBe(1);
  });

  it("con la MISMA fecha, las dos pasan y la cantidad se suma una sola vez", async () => {
    const LOTE = `L-CONC-OK-${RUN}`;

    const primera = registerInventoryEntry(
      recepcion({ batchCode: LOTE, quantity: 5, expiresAt: ENERO }),
    );
    const segunda = registerInventoryEntry(
      recepcion({ batchCode: LOTE, quantity: 4, expiresAt: ENERO }),
    );

    await Promise.all([primera, segunda]);

    const fila = await prisma.productBatch.findFirstOrThrow({
      where: { productId, batchCode: LOTE },
      select: { quantity: true },
    });
    expect(fila.quantity).toBe(9);
    expect(await prisma.inventoryEntry.count({ where: { productId } })).toBe(2);
  });
});

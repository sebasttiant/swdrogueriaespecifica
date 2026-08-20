import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";

// --------------------------------------------------------------------------
// Recepción de un faltante MANUAL pedido en cantidad.
//
// REGRESIÓN de un defecto que llegó a producción y ahí se quedó. Un faltante
// manual nace con `quantity = 1` —un marcador, no una necesidad medida— y
// gerencia después lo pide con `orderedQuantity`. La asignación cuenta contra
// `needed = originId IS NULL ? COALESCE(orderedQuantity, quantity) : quantity`,
// así que un pedido de 50 admite recibir de a poco. Pero el CHECK de la base
// acotaba `receivedQuantity <= quantity`, o sea <= 1.
//
// Recibir 2 unidades violaba la restricción y revertía la transacción ENTERA de
// `registerInventoryEntry`: la entrada, el incremento del lote y el cierre de
// todos los demás faltantes de esa misma carga. No fallaba la línea: se perdía
// la operación completa.
//
// POR QUÉ CONTRA POSTGRESQL REAL, y no con dobles. El defecto vivía en una
// restricción de la base. Los tests con mocks del servicio pasaban en verde
// mientras producción reventaba, porque un doble acepta cualquier número que se
// le escriba. Solo una restricción de verdad puede rechazarlo, y solo por eso
// este archivo existe acá y no al lado del servicio.
// --------------------------------------------------------------------------

let productId = "";

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `MAN-${Date.now()}`, name: "Amoxicilina 500mg", unit: "unidad" },
  });
  productId = product.id;
});

afterEach(async () => {
  await prisma.inventoryAllocation.deleteMany({ where: { missingItem: { productId } } });
  await prisma.missingItem.deleteMany({ where: { productId } });
  await prisma.inventoryEntry.deleteMany({ where: { productId } });
  await prisma.productBatch.deleteMany({ where: { productId } });
});

/**
 * Un faltante manual tal como lo crea el sistema: sin pendiente de cliente
 * (`originId` nulo) y con `quantity` en 1, que es el marcador que usa
 * `missing-item.service.ts`, no una cantidad que alguien haya contado.
 */
function createManualMissingItem(orderedQuantity: number) {
  return prisma.missingItem.create({
    data: {
      productId,
      quantity: 1,
      orderedQuantity,
      receivedQuantity: 0,
      status: "PEDIDO",
      originId: null,
    },
  });
}

function registerEntry(quantity: number) {
  return registerInventoryEntry({
    productId,
    quantity,
    batchCode: `L-${randomUUID().slice(0, 8)}`,
    expiresAt: new Date("2027-12-31T00:00:00Z"),
    // La clave de idempotencia es lo que activa el reparto FIFO cuantitativo;
    // sin ella el servicio toma el camino heredado y no evalúa `needed`.
    idempotencyKey: randomUUID(),
  });
}

describe("recepción parcial de un faltante manual pedido en cantidad", () => {
  it("registra la entrada completa en vez de revertirla", async () => {
    const missing = await createManualMissingItem(50);

    const result = await registerEntry(2);

    // Lo que antes se perdía entero: la entrada y el stock físico.
    expect(result.allocatedMissingCount).toBe(1);
    const batches = await prisma.productBatch.findMany({ where: { productId } });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.quantity).toBe(2);

    // Y la imputación contra el faltante, que es lo que rompía el CHECK.
    const after = await prisma.missingItem.findUniqueOrThrow({ where: { id: missing.id } });
    expect(after.receivedQuantity).toBe(2);
    // Un parcial NO cambia de estado (D10): sigue siendo un pedido al que le
    // falta mercadería.
    expect(after.status).toBe("PEDIDO");
  });

  it("acumula recepciones sucesivas hasta completar lo pedido", async () => {
    const missing = await createManualMissingItem(5);

    await registerEntry(2);
    await registerEntry(2);

    const parcial = await prisma.missingItem.findUniqueOrThrow({ where: { id: missing.id } });
    expect(parcial.receivedQuantity).toBe(4);
    expect(parcial.status).toBe("PEDIDO");

    await registerEntry(1);

    const completo = await prisma.missingItem.findUniqueOrThrow({ where: { id: missing.id } });
    expect(completo.receivedQuantity).toBe(5);
    // Completar lo pedido es lo único que lo cierra.
    expect(completo.status).toBe("RECIBIDO");
  });

  it("no imputa más de lo pedido aunque llegue de más", async () => {
    // El techo real lo pone `needed`, no la restricción de la base: el sobrante
    // entra al lote como stock vendible y no queda colgado del faltante.
    const missing = await createManualMissingItem(3);

    await registerEntry(10);

    const after = await prisma.missingItem.findUniqueOrThrow({ where: { id: missing.id } });
    expect(after.receivedQuantity).toBe(3);
    expect(after.status).toBe("RECIBIDO");

    const batches = await prisma.productBatch.findMany({ where: { productId } });
    expect(batches[0]!.quantity).toBe(10);
  });

  it("un faltante sin pedir sigue acotado por su propia cantidad", async () => {
    // Sin `orderedQuantity`, `needed` cae en `quantity`. El caso manual no
    // aflojó el contrato de los demás: solo lo corrió hasta lo que gerencia
    // pidió de verdad.
    const missing = await prisma.missingItem.create({
      data: {
        productId,
        quantity: 4,
        orderedQuantity: null,
        receivedQuantity: 0,
        status: "FALTANTE",
        originId: null,
      },
    });

    await registerEntry(9);

    const after = await prisma.missingItem.findUniqueOrThrow({ where: { id: missing.id } });
    expect(after.receivedQuantity).toBe(4);
    expect(after.status).toBe("RECIBIDO");
  });

  it("la base rechaza imputar por encima del techo, no solo el código", async () => {
    // La guarda de aplicación y la de la base son dos cosas distintas: si algún
    // día otra ruta escribe sin pasar por el servicio, esto tiene que seguir
    // fallando.
    const missing = await createManualMissingItem(6);

    await expect(
      prisma.missingItem.update({
        where: { id: missing.id },
        data: { receivedQuantity: 7 },
      }),
    ).rejects.toThrow();

    // Y hasta el techo, la base lo admite.
    const ok = await prisma.missingItem.update({
      where: { id: missing.id },
      data: { receivedQuantity: 6 },
    });
    expect(ok.receivedQuantity).toBe(6);
  });
});

import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  ProductIdentityRequiredError,
  registerInventoryEntry,
} from "@/server/services/inventory-entry.service";

// --------------------------------------------------------------------------
// Sin SKU no entra mercadería al inventario.
//
// El SKU es lo único que ata un producto de la droguería con el mismo producto
// en Orion. Cargar stock contra un producto sin identidad crea inventario que
// después nadie puede cuadrar: existe acá y no existe allá, y la diferencia
// aparece recién cuando alguien hace el conteo.
//
// El vendedor SÍ puede aplazar el SKU al tomar el pedido —tiene al cliente
// delante y no puede frenarse por eso—, pero ese aplazamiento tiene que
// resolverse antes de que la mercadería toque el inventario. Bodega es quien
// tiene la caja en la mano, con el código impreso encima: es el momento y la
// persona correctos para completarlo.
// --------------------------------------------------------------------------

let conSku = "";
let sinSku = "";
const RUN = randomUUID().slice(0, 6);

beforeAll(async () => {
  const identificado = await prisma.product.create({
    data: {
      code: `SKU-OK-${Date.now()}`,
      name: `Amoxicilina ${RUN}`,
      unit: "caja",
      orionCode: `ORN-${RUN}`,
    },
  });
  conSku = identificado.id;

  const sinIdentidad = await prisma.product.create({
    data: {
      code: `SKU-NO-${Date.now()}`,
      name: `Ibuprofeno ${RUN}`,
      unit: "caja",
      // Sin `orionCode`: el producto nació de la excepción del vendedor.
    },
  });
  sinSku = sinIdentidad.id;
});

afterEach(async () => {
  const ids = [conSku, sinSku];
  await prisma.inventoryEntry.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productBatch.deleteMany({ where: { productId: { in: ids } } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: { in: [conSku, sinSku] } } });
});

function entrada(productId: string, extra: Record<string, unknown> = {}) {
  return {
    productId,
    quantity: 5,
    batchCode: `L-${randomUUID().slice(0, 6)}`,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
    createdById: null,
    ...extra,
  };
}

describe("registerInventoryEntry · el SKU es obligatorio", () => {
  it("rechaza una entrada sobre un producto sin SKU", async () => {
    await expect(
      registerInventoryEntry(entrada(sinSku)),
    ).rejects.toBeInstanceOf(ProductIdentityRequiredError);
  });

  // El rechazo nombra el producto: quien recibe la caja tiene que saber cuál
  // completar, y un id interno no le sirve para buscarlo en la pantalla.
  it("el rechazo dice QUÉ producto le falta el SKU", async () => {
    await expect(registerInventoryEntry(entrada(sinSku))).rejects.toMatchObject({
      productId: sinSku,
      productName: `Ibuprofeno ${RUN}`,
    });
  });

  // Lo importante no es que falle: es que no deje nada a medias. Un lote creado
  // por una entrada rechazada es stock fantasma.
  it("no crea lote ni movimiento", async () => {
    await registerInventoryEntry(entrada(sinSku)).catch(() => {});

    expect(await prisma.productBatch.count({ where: { productId: sinSku } })).toBe(0);
    expect(await prisma.inventoryEntry.count({ where: { productId: sinSku } })).toBe(0);
  });

  it("acepta la entrada cuando el producto tiene SKU", async () => {
    const result = await registerInventoryEntry(entrada(conSku));

    expect(result.entry.id).toBeTruthy();
    expect(await prisma.productBatch.count({ where: { productId: conSku } })).toBe(1);
  });

  // Resolver el SKU es lo que desbloquea la recepción: el mismo productId, sin
  // crear otro producto.
  it("una vez completado el SKU, la misma entrada pasa", async () => {
    await expect(registerInventoryEntry(entrada(sinSku))).rejects.toThrow();

    await prisma.product.update({
      where: { id: sinSku },
      data: { orionCode: `ORN-TARDE-${RUN}` },
    });

    const result = await registerInventoryEntry(entrada(sinSku));
    expect(result.entry.id).toBeTruthy();
    // El producto es EL MISMO: resolver identidad nunca crea uno nuevo.
    expect(
      await prisma.product.count({ where: { name: `Ibuprofeno ${RUN}` } }),
    ).toBe(1);
  });
});

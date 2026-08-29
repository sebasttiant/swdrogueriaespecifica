import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { addProduct } from "@/server/services/product.service";
import { findProductByIdentity } from "@/server/repositories/sku-review.repository";

// --------------------------------------------------------------------------
// Un producto nace CON su SKU, o no nace con identidad y se sabe.
//
// Antes el alta no ofrecía el campo, así que todo producto nuevo nacía sin
// código: caía en la cola de "Revisión de identidad" y bloqueaba la entrada
// cuando llegaba la caja. El alta fabricaba el problema que el rechazo de la
// entrada existe para atajar.
//
// Estas pruebas van contra PostgreSQL REAL porque lo que se está afirmando es
// el comportamiento del índice único de `orionCode`, y eso un doble no lo
// prueba: un mock diría que sí a cualquier cosa.
// --------------------------------------------------------------------------

const RUN = randomUUID().slice(0, 8);
const creados: string[] = [];

async function nuevo(overrides: { orionCode?: string | null; code?: string } = {}) {
  const product = await addProduct({
    code: overrides.code ?? `SKU-${RUN}-${creados.length}`,
    name: `Producto ${RUN}-${creados.length}`,
    unit: "unidad",
    minStock: 0,
    reorderQty: 0,
    ...(overrides.orionCode !== undefined ? { orionCode: overrides.orionCode } : {}),
  });
  creados.push(product.id);
  return product;
}

afterEach(async () => {
  await prisma.product.deleteMany({ where: { id: { in: creados.splice(0) } } });
});

describe("alta de producto con SKU", () => {
  it("el producto queda con su identidad desde el INSERT", async () => {
    const orionCode = `ORN-${RUN}-A`;

    const product = await nuevo({ orionCode });

    expect(product.orionCode).toBe(orionCode);
    // Nunca existió sin código: no hay ventana en la que otro proceso lo vea
    // sin identidad y se la asigne.
    const encontrado = await findProductByIdentity({ orionCode });
    expect(encontrado?.id).toBe(product.id);
  });

  it("sin SKU el producto se crea igual, con identidad nula", async () => {
    const product = await nuevo();

    expect(product.orionCode).toBeNull();
  });

  // Dos personas dando de alta el mismo producto es el caso que va a pasar.
  // La base es la que decide, no un chequeo previo que otra transacción puede
  // adelantar entre el SELECT y el INSERT.
  it("dos productos NO pueden compartir el mismo SKU", async () => {
    const orionCode = `ORN-${RUN}-B`;
    await nuevo({ orionCode });

    await expect(nuevo({ orionCode })).rejects.toMatchObject({ code: "P2002" });
  });

  // Varios productos sin código conviven: en PostgreSQL un índice único no
  // colisiona entre NULLs. Por eso el campo vacío se normaliza a `undefined` y
  // nunca a "" —dos cadenas vacías SÍ chocarían—.
  it("varios productos sin SKU conviven sin chocar", async () => {
    await nuevo({ orionCode: null });
    await nuevo({ orionCode: null });

    const sinCodigo = await prisma.product.count({
      where: { id: { in: creados }, orionCode: null },
    });
    expect(sinCodigo).toBe(2);
  });
});

import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  countActionableMissingItems,
  listMissingItems,
} from "@/server/repositories/missing-item.repository";

// --------------------------------------------------------------------------
// El contador y la lista tienen que hablar del mismo conjunto.
//
// La cola "Por pedir" mostraba el badge en 1 y la tabla decía "Nada por pedir".
// La causa es la lógica de tres valores de SQL: el filtro de cuarentena compara
// `receivedQuantity > orderedQuantity`, y un faltante recién creado tiene
// `orderedQuantity` NULL. `0 > NULL` es NULL, `NOT NULL` sigue siendo NULL, y
// un WHERE que evalúa NULL descarta la fila.
//
// Es decir: TODO faltante nuevo quedaba invisible en la cola principal, que es
// justo la pantalla donde gerencia decide qué comprar. El contador no aplica
// ese filtro, y por eso las dos vistas se contradecían.
//
// El propio comentario del repositorio dice que una `orderedQuantity` NULA NO
// es inválida —"todavía sin derivar... siguen en la cola"—. La intención estaba
// escrita; la implementación hacía lo contrario.
// --------------------------------------------------------------------------

let productId = "";
const RUN = randomUUID().slice(0, 6);

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `VIS-${Date.now()}`, name: `Gel Muscular ${RUN}`, unit: "unidad" },
  });
  productId = product.id;
});

afterEach(async () => {
  await prisma.missingItem.deleteMany({ where: { productId } });
});

async function nuevoFaltante(overrides: {
  orderedQuantity?: number | null;
  receivedQuantity?: number;
} = {}): Promise<string> {
  const item = await prisma.missingItem.create({
    data: {
      productId,
      quantity: 10,
      status: "FALTANTE",
      receivedQuantity: overrides.receivedQuantity ?? 0,
      ...(overrides.orderedQuantity !== undefined
        ? { orderedQuantity: overrides.orderedQuantity }
        : {}),
    },
  });
  return item.id;
}

async function idsEnPorPedir(): Promise<string[]> {
  const page = await listMissingItems({ scope: "actionable", take: 50 });
  return page.items.map((item) => item.id);
}

describe("cola 'Por pedir' · el contador y la lista coinciden", () => {
  // El caso que rompía: un faltante recién creado, sin cantidad pedida todavía.
  it("un faltante SIN orderedQuantity aparece en la lista", async () => {
    const id = await nuevoFaltante({ orderedQuantity: null });

    expect(await idsEnPorPedir()).toContain(id);
  });

  it("el contador y la lista devuelven lo MISMO", async () => {
    await nuevoFaltante({ orderedQuantity: null });
    await nuevoFaltante({ orderedQuantity: 5, receivedQuantity: 0 });
    await nuevoFaltante({ orderedQuantity: 8, receivedQuantity: 3 });

    const contador = await countActionableMissingItems();
    const lista = await idsEnPorPedir();

    expect(lista).toHaveLength(contador);
  });

  it("con orderedQuantity ya derivada sigue apareciendo", async () => {
    const id = await nuevoFaltante({ orderedQuantity: 10, receivedQuantity: 0 });

    expect(await idsEnPorPedir()).toContain(id);
  });

  // La cuarentena real: llegó MÁS de lo que se pidió. Ese dato sí es inválido
  // y no pertenece a ninguna cola operativa.
  it("un faltante con más recibido que pedido SIGUE fuera de la lista", async () => {
    const id = await nuevoFaltante({ orderedQuantity: 5, receivedQuantity: 9 });

    expect(await idsEnPorPedir()).not.toContain(id);
  });

  it("recibido IGUAL a lo pedido no es cuarentena", async () => {
    const id = await nuevoFaltante({ orderedQuantity: 5, receivedQuantity: 5 });

    expect(await idsEnPorPedir()).toContain(id);
  });
});

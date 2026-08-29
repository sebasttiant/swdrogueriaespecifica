import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";
import { registerPending } from "@/server/services/pending.service";
import {
  countStockoutProducts,
  listStockoutProducts,
} from "@/server/services/stockout.service";

// --------------------------------------------------------------------------
// EL AVISO DE QUIEBRE PARA BODEGA, contra PostgreSQL real.
//
// El aviso responde una sola pregunta: ¿qué producto QUE LLEVAMOS se quedó sin
// con qué cubrir lo ya prometido a un cliente?
//
//   déficit = cantidad pedida − inventario reservado
//
// Va contra la base real y no con dobles porque todo lo que lo alimenta es
// SQL: la reserva se calcula con `FOR UPDATE` sobre los lotes, el agregado por
// producto lo hace PostgreSQL, y el déficit es una comparación columna contra
// columna. Un doble diría que sí a cualquier cosa.
//
// Lo que se prueba acá es el contrato que pidió gerencia:
//   · no muestra datos del cliente
//   · no duplica por el mismo déficit
//   · se actualiza cuando entra mercadería
//   · desaparece cuando el déficit queda cubierto
//   · no reemplaza la gestión de compra (el faltante sigue existiendo)
// --------------------------------------------------------------------------

let productId = "";
let sellerId = "";

beforeAll(async () => {
  // El pendiente referencia a su vendedor con clave foránea: un id inventado
  // revienta el `create` antes de llegar a lo que este archivo prueba.
  const seller = await prisma.user.create({
    data: { email: `bodega-quiebre-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  sellerId = seller.id;

  const product = await prisma.product.create({
    data: {
      orionCode: `ORN-SO-${Date.now()}`,
      code: `SO-${Date.now()}`,
      name: "Glucerna 400g",
      unit: "unidad",
    },
  });
  productId = product.id;
});

// Mismo orden que el resto de los archivos del gate: la reserva referencia al
// lote con `onDelete: Restrict`, así que el lote se borra después. Y el archivo
// tiene que dejar el esquema VACÍO: `harness.pg.test.ts` afirma que
// pending/productBatch/missingItem quedan en cero.
afterEach(async () => {
  // El outbox va PRIMERO y no es un detalle: registrar una entrada encola el
  // aviso de disponibilidad, y esas filas apuntan al vendedor con
  // `onDelete: Restrict`. Sin limpiarlas, el `afterAll` no puede borrar el
  // usuario y —peor— los eventos sobrevivientes se cuelan en los archivos que
  // corren después, que cuentan filas del outbox. La suite corre con
  // `fileParallelism: false` sobre UNA sola base: el residuo de acá es la
  // falla de otro.
  await prisma.notificationOutbox.deleteMany({ where: { recipientId: sellerId } });
  await prisma.pendingInventoryReservation.deleteMany({ where: { batch: { productId } } });
  await prisma.inventoryAllocation.deleteMany({ where: { missingItem: { productId } } });
  await prisma.missingItem.deleteMany({ where: { productId } });
  await prisma.inventoryEntry.deleteMany({ where: { productId } });
  await prisma.productBatch.deleteMany({ where: { productId } });
  await prisma.pending.deleteMany({ where: { productId } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.user.deleteMany({ where: { id: sellerId } });
});

function nuevoPendiente(quantity: number, customerName: string) {
  return registerPending({
    productId,
    quantity,
    promisedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    customerName,
    customerPhone: "3001234567",
    createdById: sellerId,
    idempotencyKey: randomUUID(),
  });
}

function entrada(quantity: number) {
  return registerInventoryEntry({
    productId,
    quantity,
    batchCode: `L-${randomUUID().slice(0, 8)}`,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    createdById: null,
    idempotencyKey: randomUUID(),
  });
}

/** La fila del aviso para este producto, o `undefined` si ya no aparece. */
async function aviso() {
  const filas = await listStockoutProducts();
  return filas.find((fila) => fila.productId === productId);
}

describe("quiebre de stock · el déficit", () => {
  it("sin stock, el déficit es todo lo pedido", async () => {
    await nuevoPendiente(12, "Cliente A");

    expect((await aviso())?.missingQuantity).toBe(12);
    expect(await countStockoutProducts()).toBe(1);
  });

  // DÉFICIT PARCIAL: hay algo en el estante, pero no alcanza. El aviso tiene
  // que hablar de lo que FALTA, no de lo que se pidió: pedirle a bodega que
  // busque 12 cuando ya hay 5 reservadas la manda a buscar de más.
  it("con stock insuficiente, avisa solo por lo que falta", async () => {
    await entrada(5);
    await nuevoPendiente(12, "Cliente B");

    const fila = await aviso();
    expect(fila?.missingQuantity).toBe(7);
  });

  it("con stock de sobra no hay quiebre", async () => {
    await entrada(20);
    await nuevoPendiente(12, "Cliente C");

    expect(await aviso()).toBeUndefined();
    expect(await countStockoutProducts()).toBe(0);
  });
});

describe("quiebre de stock · no duplica", () => {
  // UNA fila por PRODUCTO, no por pendiente. Tres clientes esperando lo mismo
  // son UNA búsqueda en el depósito, no tres. Duplicar convertiría el aviso en
  // una lista que crece sola y que nadie termina de leer.
  it("agrupa varios pendientes del mismo producto en una sola fila", async () => {
    await nuevoPendiente(4, "Cliente D");
    await nuevoPendiente(6, "Cliente E");
    await nuevoPendiente(2, "Cliente F");

    const filas = (await listStockoutProducts()).filter((f) => f.productId === productId);

    expect(filas).toHaveLength(1);
    expect(filas[0]?.missingQuantity).toBe(12);
    expect(filas[0]?.waitingCount).toBe(3);
    expect(await countStockoutProducts()).toBe(1);
  });

  // El contador y la lista se leen en pantallas distintas —el chip de la barra
  // y la lista de Recepción—. Si discrepan, el chip promete trabajo que la
  // pantalla no muestra, y bodega deja de creerle a los dos.
  it("el contador y la lista siempre dicen lo mismo", async () => {
    await nuevoPendiente(3, "Cliente G");
    await entrada(1);

    const filas = await listStockoutProducts();
    expect(await countStockoutProducts()).toBe(filas.length);
  });
});

describe("quiebre de stock · la entrada lo mueve", () => {
  // ENTRADA PARCIAL: el aviso no desaparece, se ACTUALIZA. Si desapareciera al
  // primer bulto, bodega dejaría de buscar el resto.
  it("una entrada parcial baja el déficit sin borrar el aviso", async () => {
    await nuevoPendiente(10, "Cliente H");
    expect((await aviso())?.missingQuantity).toBe(10);

    await entrada(4);

    expect((await aviso())?.missingQuantity).toBe(6);
  });

  // ENTRADA COMPLETA: desaparece. Es la única señal de que el trabajo terminó;
  // un aviso que sobrevive a su causa enseña a ignorar la barra entera.
  it("una entrada que cubre el déficit hace desaparecer el aviso", async () => {
    await nuevoPendiente(10, "Cliente I");

    await entrada(10);

    expect(await aviso()).toBeUndefined();
    expect(await countStockoutProducts()).toBe(0);
  });

  it("desaparece también sumando entradas chicas", async () => {
    await nuevoPendiente(9, "Cliente J");

    await entrada(4);
    expect((await aviso())?.missingQuantity).toBe(5);
    await entrada(5);

    expect(await aviso()).toBeUndefined();
  });
});

describe("quiebre de stock · qué NO hace", () => {
  // El tipo que devuelve el servicio no tiene campo de cliente, y esto lo fija
  // contra la BASE: la consulta no puede empezar a traerlo sin romper acá.
  // Bodega prioriza con el NÚMERO de gente que espera; para buscar una caja no
  // hace falta saber para quién es.
  it("nunca trae datos del cliente", async () => {
    await nuevoPendiente(5, "Josefina Pérez");

    const fila = await aviso();
    const serializado = JSON.stringify(fila);

    expect(fila?.waitingCount).toBe(1);
    expect(serializado).not.toContain("Josefina");
    expect(serializado).not.toContain("3001234567");
  });

  // El aviso a bodega y la gestión de compra de gerencia son DOS cosas. El
  // faltante sigue naciendo y sigue siendo de gerencia: bodega detecta y
  // recibe existencia física, gerencia decide y compra.
  it("no reemplaza la gestión de compra: el faltante sigue existiendo", async () => {
    const resultado = await nuevoPendiente(8, "Cliente K");

    expect(resultado.missingItem).not.toBeNull();
    const faltantes = await prisma.missingItem.findMany({ where: { productId } });
    expect(faltantes).toHaveLength(1);
    expect(faltantes[0]?.originId).toBe(resultado.pending.id);

    // Y el aviso convive con él, sin pisarlo.
    expect((await aviso())?.missingQuantity).toBe(8);
  });

  // Un producto dado de baja no es un quiebre: es una decisión ya tomada.
  // Mandar a bodega a buscar algo que la droguería dejó de vender es trabajo
  // inventado.
  it("ignora los productos dados de baja", async () => {
    await nuevoPendiente(5, "Cliente L");
    expect(await aviso()).toBeDefined();

    await prisma.product.update({ where: { id: productId }, data: { active: false } });
    try {
      expect(await aviso()).toBeUndefined();
    } finally {
      await prisma.product.update({ where: { id: productId }, data: { active: true } });
    }
  });
});

describe("quiebre de stock · concurrencia", () => {
  // RESERVA CONCURRENTE. Dos vendedores cargan a la vez contra el mismo lote:
  // `claimableStockForPending` toma `FOR UPDATE` sobre los lotes, así que las
  // unidades se reparten UNA sola vez.
  //
  // Sin ese lock los dos verían las mismas 5 disponibles, las prometerían a dos
  // clientes distintos y el aviso diría que no falta nada — mientras el segundo
  // cliente se queda sin producto y nadie se entera.
  it("dos pendientes simultáneos no se reparten dos veces el mismo stock", async () => {
    await entrada(5);

    await Promise.all([
      nuevoPendiente(4, "Cliente M"),
      nuevoPendiente(4, "Cliente N"),
    ]);

    const reservado = await prisma.pending.aggregate({
      where: { productId },
      _sum: { inventoryReadyQuantity: true },
    });
    // Entre los dos toman exactamente las 5 que había, ni una más.
    expect(reservado._sum.inventoryReadyQuantity).toBe(5);

    // Y el déficit real es 3: pidieron 8, había 5. Si el lock fallara, cada uno
    // habría reservado 4 y el aviso diría que falta 0.
    expect((await aviso())?.missingQuantity).toBe(3);
  });

  it("dos entradas simultáneas no borran el aviso de más", async () => {
    await nuevoPendiente(10, "Cliente O");

    await Promise.all([entrada(3), entrada(3)]);

    expect((await aviso())?.missingQuantity).toBe(4);
  });
});

import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  listArrivedMissingItems,
  listMissingItems,
} from "@/server/repositories/missing-item.repository";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";
import { markMissingItemsOrdered } from "@/server/services/missing-item.service";

// La membresía de "Ya pedidos" se prueba contra PostgreSQL real porque lo que
// se verifica es la CONSULTA: que la cola activa y el historial sean conjuntos
// disjuntos, y que la comparación `receivedQuantity < orderedQuantity` la haga
// la base sobre columnas y no el código sobre un objeto que el test fabricó.
// Un doble en memoria devuelve lo que se le pida y no prueba ninguna de las dos.

let productId = "";
let actorId = "";

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { orionCode: `ORN-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, code: `YAP-${Date.now()}`, name: "Amoxicilina", unit: "unidad" },
  });
  productId = product.id;

  const actor = await prisma.user.create({
    data: { email: `gerente-${randomUUID()}@test.local`, name: "Gerente" },
  });
  actorId = actor.id;
});

afterEach(async () => {
  await prisma.inventoryAllocation.deleteMany({ where: { missingItem: { productId } } });
  await prisma.missingItem.deleteMany({ where: { productId } });
  await prisma.inventoryEntry.deleteMany({ where: { productId } });
  await prisma.productBatch.deleteMany({ where: { productId } });
});

type ItemInput = {
  status?: "FALTANTE" | "PEDIDO" | "EN_BODEGA" | "RECIBIDO" | "CANCELADO";
  quantity?: number;
  orderedQuantity?: number | null;
  receivedQuantity?: number;
  confirmedAt?: Date | null;
};

async function newItem(input: ItemInput = {}): Promise<string> {
  const item = await prisma.missingItem.create({
    data: {
      productId,
      quantity: input.quantity ?? 10,
      status: input.status ?? "FALTANTE",
      receivedQuantity: input.receivedQuantity ?? 0,
      ...(input.orderedQuantity !== undefined
        ? { orderedQuantity: input.orderedQuantity }
        : {}),
      ...(input.confirmedAt ? { confirmedAt: input.confirmedAt } : {}),
    },
  });
  return item.id;
}

async function activeQueueIds(): Promise<string[]> {
  const { items } = await listMissingItems({ scope: "ordered", take: 100 });
  return items.map((item) => item.id);
}

describe("Ya pedidos · membresía de la cola activa", () => {
  it("incluye un PEDIDO al que todavía no le llegó todo", async () => {
    const id = await newItem({ status: "PEDIDO", orderedQuantity: 10, receivedQuantity: 4 });

    expect(await activeQueueIds()).toEqual([id]);
  });

  it("incluye un PEDIDO sin nada recibido", async () => {
    const id = await newItem({ status: "PEDIDO", orderedQuantity: 10, receivedQuantity: 0 });

    expect(await activeQueueIds()).toEqual([id]);
  });

  it("EXCLUYE un RECIBIDO: completado es historial, no cola activa", async () => {
    await newItem({ status: "RECIBIDO", orderedQuantity: 10, receivedQuantity: 10 });

    expect(await activeQueueIds()).toEqual([]);
  });

  it("EXCLUYE un PEDIDO que ya recibió todo aunque nadie le haya cambiado el estado", async () => {
    await newItem({ status: "PEDIDO", orderedQuantity: 10, receivedQuantity: 10 });

    expect(await activeQueueIds()).toEqual([]);
  });

  it("EXCLUYE un CANCELADO", async () => {
    await newItem({ status: "CANCELADO", orderedQuantity: 10 });

    expect(await activeQueueIds()).toEqual([]);
  });

  it("EXCLUYE un FALTANTE que nadie marcó", async () => {
    await newItem({ status: "FALTANTE" });

    expect(await activeQueueIds()).toEqual([]);
  });

  // Los pedidos del flujo viejo "OK gerencia" quedaron en FALTANTE con
  // `confirmedAt`. Son órdenes REALES que nunca se recibieron: sacarlas de la
  // cola activa las volvería invisibles para la operación.
  it("incluye los pedidos históricos con confirmedAt sin recibir", async () => {
    const id = await newItem({
      status: "FALTANTE",
      confirmedAt: new Date("2026-07-01T12:00:00Z"),
      orderedQuantity: 10,
    });

    expect(await activeQueueIds()).toEqual([id]);
  });
});

describe("Ya pedidos · cuarentena de datos inválidos", () => {
  it("EXCLUYE de la cola activa un pedido que recibió MÁS de lo esperado", async () => {
    await newItem({ status: "PEDIDO", orderedQuantity: 5, receivedQuantity: 9 });

    expect(await activeQueueIds()).toEqual([]);
  });

  it("lo deja visible en la cuarentena, no lo desaparece", async () => {
    const exceso = await newItem({ status: "PEDIDO", orderedQuantity: 5, receivedQuantity: 9 });

    const { items } = await listMissingItems({ scope: "quarantine", take: 100 });

    expect(items.map((item) => item.id)).toEqual([exceso]);
  });

  it("un pedido sano no cae en cuarentena", async () => {
    await newItem({ status: "PEDIDO", orderedQuantity: 5, receivedQuantity: 5 });

    const { items } = await listMissingItems({ scope: "quarantine", take: 100 });

    expect(items).toEqual([]);
  });

  // La otra invalidez imaginable —cantidad esperada ≤ 0— no se filtra en la
  // consulta porque la BASE la hace imposible. Este test fija ese constraint:
  // si una migración futura lo afloja, la cuarentena deja de estar completa y
  // hay que volver a filtrarla en código. Mismo patrón que ledger-schema.
  it("la base impide una cantidad esperada de cero o negativa", async () => {
    const [constraint] = await prisma.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'missing_items_ordered_quantity_positive'
    `;

    expect(constraint?.definition).toContain("orderedQuantity");
    expect(constraint?.definition).toMatch(/> 0/);

    await expect(
      newItem({ status: "PEDIDO", quantity: 1, orderedQuantity: 0 }),
    ).rejects.toThrow();
  });
});

describe("Ya pedidos · el chulito deriva la cantidad esperada (D10)", () => {
  it("escribe orderedQuantity = quantity porque el gerente no declara cantidad", async () => {
    const id = await newItem({ status: "FALTANTE", quantity: 7, orderedQuantity: null });

    await markMissingItemsOrdered({ ids: [id], orderedById: actorId });

    const item = await prisma.missingItem.findUniqueOrThrow({ where: { id } });
    expect(item.status).toBe("PEDIDO");
    expect(item.orderedQuantity).toBe(7);
  });

  it("NO pisa una cantidad ya declarada por el formulario completo", async () => {
    const id = await newItem({ status: "FALTANTE", quantity: 7, orderedQuantity: 3 });

    await markMissingItemsOrdered({ ids: [id], orderedById: actorId });

    const item = await prisma.missingItem.findUniqueOrThrow({ where: { id } });
    expect(item.orderedQuantity).toBe(3);
  });

  it("deja el faltante recién pedido dentro de la cola activa", async () => {
    const id = await newItem({ status: "FALTANTE", quantity: 7, orderedQuantity: null });

    await markMissingItemsOrdered({ ids: [id], orderedById: actorId });

    expect(await activeQueueIds()).toEqual([id]);
  });
});

// --------------------------------------------------------------------------
// Los ítems de este archivo son INFORMATIVOS (`newItem` no les da pendiente).
// La entrada de inventario ya no les asigna stock: solo reparte a los ligados a
// una venta. Un informativo pedido queda en "Ya pedidos" como historial, y
// ninguna entrada lo mueve. La recepción parcial de un ligado a venta se prueba
// en `pending-reception-flow.pg.test.ts` y `manual-missing-item-receipt.pg.test.ts`.
// --------------------------------------------------------------------------
describe("Ya pedidos · la entrada no recibe informativos", () => {
  async function receive(quantity: number): Promise<void> {
    await registerInventoryEntry({
      productId,
      quantity,
      batchCode: `L-${randomUUID().slice(0, 8)}`,
      expiresAt: new Date("2027-01-31T00:00:00Z"),
      createdById: actorId,
      idempotencyKey: randomUUID(),
    });
  }

  it("una entrada no toca un PEDIDO informativo: sigue sin recibido y DENTRO de la cola", async () => {
    const id = await newItem({ status: "PEDIDO", quantity: 10, orderedQuantity: 10 });

    await receive(4);

    const item = await prisma.missingItem.findUniqueOrThrow({ where: { id } });
    expect(item.receivedQuantity).toBe(0);
    expect(item.status).toBe("PEDIDO");
    expect(await activeQueueIds()).toEqual([id]);
  });

  it("aunque entre todo lo pedido, NO pasa a RECIBIDO", async () => {
    const id = await newItem({ status: "PEDIDO", quantity: 10, orderedQuantity: 10 });

    await receive(10);

    const item = await prisma.missingItem.findUniqueOrThrow({ where: { id } });
    expect(item.receivedQuantity).toBe(0);
    expect(item.status).toBe("PEDIDO");
    expect(await activeQueueIds()).toEqual([id]);
  });

  // REGRESIÓN (D10): al dejar de escribir EN_BODEGA en un parcial, estos ítems
  // se caían de la pantalla de entradas. La consulta sigue igual; el parcial se
  // arma escribiendo el estado porque una entrada ya no produce uno informativo.
  it("un parcial sigue visible en la pantalla de entradas, con lo que falta", async () => {
    const id = await newItem({ status: "PEDIDO", quantity: 10, orderedQuantity: 10, receivedQuantity: 4 });

    const enBodega = await listArrivedMissingItems();
    const item = enBodega.find((row) => row.id === id);
    expect(item).toBeDefined();
    expect(item?.pendingQuantity).toBe(6);
  });

  it("uno completo no aparece en la pantalla de entradas", async () => {
    const id = await newItem({ status: "RECIBIDO", quantity: 10, orderedQuantity: 10, receivedQuantity: 10 });

    const enBodega = await listArrivedMissingItems();
    expect(enBodega.map((row) => row.id)).not.toContain(id);
  });

  it("un FALTANTE informativo no recibe nada de la entrada", async () => {
    const id = await newItem({ status: "FALTANTE", quantity: 10, orderedQuantity: 10 });

    await receive(4);

    const item = await prisma.missingItem.findUniqueOrThrow({ where: { id } });
    expect(item.receivedQuantity).toBe(0);
    expect(item.status).toBe("FALTANTE");
  });
});

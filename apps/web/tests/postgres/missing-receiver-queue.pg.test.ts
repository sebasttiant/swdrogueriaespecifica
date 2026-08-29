import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { listReceiverQueue } from "@/server/services/missing-receiver.service";

// --------------------------------------------------------------------------
// Lo que bodega puede ver, verificado contra la base.
//
// Que la pantalla no dibuje el nombre del cliente no alcanza: si la consulta lo
// trae, viajó por la red y quedó en el payload. La minimización tiene que
// ocurrir en el `select`, y eso solo se demuestra mirando lo que vuelve.
// --------------------------------------------------------------------------

let productId = "";
let vendedorId = "";
const RUN = randomUUID().slice(0, 6);

beforeAll(async () => {
  const lab = await prisma.laboratory.create({ data: { name: `Genfar ${RUN}` } });
  const product = await prisma.product.create({
    data: {
      code: `RCV-${Date.now()}`,
      name: `Amoxicilina ${RUN}`,
      unit: "caja",
      orionCode: `ORN-${RUN}`,
      laboratoryId: lab.id,
    },
  });
  productId = product.id;
  const user = await prisma.user.create({
    data: { email: `v-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  vendedorId = user.id;
});

afterEach(async () => {
  await prisma.missingItem.deleteMany({ where: { productId } });
  await prisma.pending.deleteMany({ where: { productId } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.laboratory.deleteMany({ where: { name: { contains: RUN } } });
  await prisma.user.deleteMany({ where: { id: vendedorId } });
});

type Estado = "FALTANTE" | "PEDIDO" | "EN_BODEGA" | "RECIBIDO" | "CANCELADO";

async function nuevoFaltante(
  status: Estado,
  extra: { orderedQuantity?: number; receivedQuantity?: number; conPendiente?: boolean } = {},
): Promise<string> {
  let originId: string | undefined;
  if (extra.conPendiente) {
    const pending = await prisma.pending.create({
      data: {
        productId,
        quantity: 10,
        promisedAt: new Date("2026-09-01T15:00:00Z"),
        createdById: vendedorId,
        // PII que NO debe salir en la cola de recepción.
        customerName: "Doña Marta",
        customerPhone: "3001234567",
        customerAddress: "Calle 96 #66-98",
        note: "Llamar antes de las 6",
      },
    });
    originId = pending.id;
  }
  const item = await prisma.missingItem.create({
    data: {
      productId,
      quantity: 10,
      status,
      orderedQuantity: extra.orderedQuantity ?? null,
      receivedQuantity: extra.receivedQuantity ?? 0,
      orderedAt: status === "PEDIDO" || status === "EN_BODEGA" ? new Date() : null,
      ...(originId ? { originId } : {}),
    },
  });
  return item.id;
}

describe("listReceiverQueue · qué ve bodega", () => {
  it("muestra lo PEDIDO", async () => {
    const id = await nuevoFaltante("PEDIDO");

    const cola = await listReceiverQueue("PEDIDO");

    expect(cola.map((i) => i.id)).toContain(id);
  });

  it("muestra lo que llegó a bodega", async () => {
    const id = await nuevoFaltante("EN_BODEGA");

    const cola = await listReceiverQueue("EN_BODEGA");

    expect(cola.map((i) => i.id)).toContain(id);
  });

  // FALTANTE es la cola de COMPRAS: nadie lo pidió todavía. Mostrarlo invitaría
  // a recibir mercadería que no se compró.
  it("NO muestra lo que todavía nadie pidió", async () => {
    const id = await nuevoFaltante("FALTANTE");

    for (const scope of ["PEDIDO", "EN_BODEGA"] as const) {
      expect((await listReceiverQueue(scope)).map((i) => i.id)).not.toContain(id);
    }
  });

  it("NO muestra lo descartado ni lo ya recibido", async () => {
    const cancelado = await nuevoFaltante("CANCELADO");
    const recibido = await nuevoFaltante("RECIBIDO");

    for (const scope of ["PEDIDO", "EN_BODEGA"] as const) {
      const ids = (await listReceiverQueue(scope)).map((i) => i.id);
      expect(ids).not.toContain(cancelado);
      expect(ids).not.toContain(recibido);
    }
  });
});

describe("listReceiverQueue · qué NO sale de la base", () => {
  it("no trae nombre, teléfono, dirección ni notas del cliente", async () => {
    await nuevoFaltante("PEDIDO", { conPendiente: true });

    const cola = await listReceiverQueue("PEDIDO");
    const payload = JSON.stringify(cola);

    expect(cola).toHaveLength(1);
    for (const pii of ["Doña Marta", "3001234567", "Calle 96", "Llamar antes"]) {
      expect(payload).not.toContain(pii);
    }
  });

  it("sí trae la trazabilidad al pendiente, sin sus datos comerciales", async () => {
    await nuevoFaltante("PEDIDO", { conPendiente: true });

    const [item] = await listReceiverQueue("PEDIDO");

    expect(item?.originId).not.toBeNull();
    expect(Object.keys(item ?? {})).not.toContain("customerName");
  });
});

describe("listReceiverQueue · lo que bodega necesita", () => {
  it("trae la identidad EXACTA, no solo el nombre", async () => {
    await nuevoFaltante("PEDIDO");

    const [item] = await listReceiverQueue("PEDIDO");

    expect(item?.productId).toBe(productId);
    expect(item?.orionCode).toBe(`ORN-${RUN}`);
    expect(item?.laboratoryName).toBe(`Genfar ${RUN}`);
  });

  // El número con el que trabaja el depósito: cuánto falta descargar.
  it("calcula lo que falta recibir", async () => {
    await nuevoFaltante("PEDIDO", { orderedQuantity: 8, receivedQuantity: 3 });

    const [item] = await listReceiverQueue("PEDIDO");

    expect(item?.outstandingQuantity).toBe(5);
  });

  it("sin cantidad pedida usa la del cliente", async () => {
    await nuevoFaltante("PEDIDO", { orderedQuantity: undefined });

    const [item] = await listReceiverQueue("PEDIDO");

    expect(item?.outstandingQuantity).toBe(10);
  });

  it("nunca devuelve un faltante negativo", async () => {
    await nuevoFaltante("PEDIDO", { orderedQuantity: 2, receivedQuantity: 9 });

    const [item] = await listReceiverQueue("PEDIDO");

    expect(item?.outstandingQuantity).toBe(0);
  });
});

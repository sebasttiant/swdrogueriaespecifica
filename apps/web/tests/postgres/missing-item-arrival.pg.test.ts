import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { markMissingItemArrived } from "@/server/repositories/missing-item.repository";

// --------------------------------------------------------------------------
// La llegada física: PEDIDO → EN_BODEGA.
//
// La transición es un compare-and-set: se escribe SOLO si la fila sigue en
// PEDIDO. Eso es lo que hace que dos personas descargando el mismo pedido no
// produzcan dos llegadas — la segunda ve `count === 0` y sabe que llegó tarde.
//
// Y lo que NO hace importa igual: no crea inventario y no avisa al vendedor.
// "Llegó a bodega" no es "disponible para entregar": eso lo da el registro de
// la entrada, con lote y cantidad real. Notificar antes mandaría al vendedor a
// llamar a un cliente que va a venir a buscar algo que el sistema no tiene.
// --------------------------------------------------------------------------

let productId = "";
let vendedorId = "";
let bodegaId = "";
const RUN = randomUUID().slice(0, 6);

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `ARR-${Date.now()}`, name: `Ibuprofeno ${RUN}`, unit: "caja" },
  });
  productId = product.id;
  const vendedor = await prisma.user.create({
    data: { email: `v-${randomUUID()}@t.local`, name: "Vendedora" },
  });
  vendedorId = vendedor.id;
  const bodega = await prisma.user.create({
    data: { email: `b-${randomUUID()}@t.local`, name: "Bodega", role: "BODEGA" },
  });
  bodegaId = bodega.id;
});

afterEach(async () => {
  await prisma.missingItem.deleteMany({ where: { productId } });
  await prisma.pending.deleteMany({ where: { productId } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.user.deleteMany({ where: { id: { in: [vendedorId, bodegaId] } } });
});

type Estado = "FALTANTE" | "PEDIDO" | "EN_BODEGA" | "RECIBIDO" | "CANCELADO";

async function nuevoFaltante(
  status: Estado,
  opciones: { conPendiente?: boolean } = {},
): Promise<string> {
  let originId: string | undefined;
  if (opciones.conPendiente) {
    const pending = await prisma.pending.create({
      data: {
        productId,
        quantity: 5,
        promisedAt: new Date("2026-09-01T15:00:00Z"),
        createdById: vendedorId,
        availabilityStatus: "ESPERANDO",
      },
    });
    originId = pending.id;
  }
  const item = await prisma.missingItem.create({
    data: {
      productId,
      quantity: 5,
      status,
      orderedAt: status === "PEDIDO" ? new Date() : null,
      ...(originId ? { originId } : {}),
    },
  });
  return item.id;
}

const marcar = (id: string) =>
  prisma.$transaction((tx) =>
    markMissingItemArrived(tx, { id, arrivedById: bodegaId, arrivedAt: new Date() }),
  );

describe("markMissingItemArrived · la transición", () => {
  it("mueve PEDIDO a EN_BODEGA y firma quién recibió", async () => {
    const id = await nuevoFaltante("PEDIDO");

    expect(await marcar(id)).toBe(1);

    const fila = await prisma.missingItem.findUniqueOrThrow({ where: { id } });
    expect(fila.status).toBe("EN_BODEGA");
    expect(fila.arrivedById).toBe(bodegaId);
    expect(fila.arrivedAt).not.toBeNull();
  });

  // Solo desde PEDIDO. Recibir algo que nadie compró, o volver a recibir lo ya
  // recibido, son operaciones sin sentido y el CAS las rechaza sin escribir.
  it.each(["FALTANTE", "EN_BODEGA", "RECIBIDO", "CANCELADO"] as const)(
    "rechaza desde %s sin tocar la fila",
    async (estado) => {
      const id = await nuevoFaltante(estado);

      expect(await marcar(id)).toBe(0);
      expect(
        (await prisma.missingItem.findUniqueOrThrow({ where: { id } })).status,
      ).toBe(estado);
    },
  );
});

describe("markMissingItemArrived · lo que NO hace", () => {
  it("no crea inventario", async () => {
    const id = await nuevoFaltante("PEDIDO", { conPendiente: true });

    await marcar(id);

    const item = await prisma.missingItem.findUniqueOrThrow({ where: { id } });
    expect(item.receivedQuantity).toBe(0);
    expect(await prisma.productBatch.count({ where: { productId } })).toBe(0);
  });

  // LLEGO_BODEGA no es disponibilidad: el vendedor se entera de que la caja
  // está en el local, no de que puede entregarla.
  it("avanza el pendiente a LLEGO_BODEGA, no a disponible", async () => {
    const id = await nuevoFaltante("PEDIDO", { conPendiente: true });

    await marcar(id);

    const { originId } = await prisma.missingItem.findUniqueOrThrow({ where: { id } });
    const pending = await prisma.pending.findUniqueOrThrow({
      where: { id: originId! },
    });
    expect(pending.availabilityStatus).toBe("LLEGO_BODEGA");
    expect(pending.inventoryReadyQuantity).toBe(0);
  });

  it("NO encola aviso de llegada al vendedor", async () => {
    const id = await nuevoFaltante("PEDIDO", { conPendiente: true });

    await marcar(id);

    expect(await prisma.notificationOutbox.count()).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Concurrencia REAL, con barreras.
//
// `Promise.all` no demuestra nada por sí solo: nada garantiza que las dos
// transacciones se solapen. Acá la segunda no arranca hasta que la primera
// escribió, y la primera no confirma hasta que la segunda ya lo intentó. Sin
// esas dos barreras la prueba pasa aunque el compare-and-set no exista.
// --------------------------------------------------------------------------
function barrera(): { esperar: Promise<void>; abrir: () => void } {
  let abrir!: () => void;
  const esperar = new Promise<void>((r) => { abrir = r; });
  return { esperar, abrir };
}

describe("markMissingItemArrived · dos personas descargando el mismo pedido", () => {
  it("solo una gana; la otra recibe conflicto", async () => {
    const id = await nuevoFaltante("PEDIDO");
    const primeraEscribio = barrera();
    const segundaIntento = barrera();
    const orden: string[] = [];

    const primera = prisma.$transaction(async (tx) => {
      const count = await markMissingItemArrived(tx, {
        id, arrivedById: bodegaId, arrivedAt: new Date(),
      });
      orden.push("A escribió");
      primeraEscribio.abrir();
      // No confirma hasta que B ya intentó: sin esta barrera A podría terminar
      // antes de que B arranque, y no se probaría el solapamiento.
      await segundaIntento.esperar;
      return count;
    });

    const segunda = (async () => {
      await primeraEscribio.esperar;
      return prisma.$transaction(async (tx) => {
        orden.push("B intenta");
        segundaIntento.abrir();
        const count = await markMissingItemArrived(tx, {
          id, arrivedById: bodegaId, arrivedAt: new Date(),
        });
        orden.push("B resolvió");
        return count;
      });
    })();

    const [a, b] = await Promise.all([primera, segunda]);

    // Una escribe, la otra no. Cuál gana no importa; que solo gane una, sí.
    expect([a, b].filter((n) => n === 1)).toHaveLength(1);
    expect([a, b].filter((n) => n === 0)).toHaveLength(1);
    expect(orden.indexOf("A escribió")).toBeLessThan(orden.indexOf("B resolvió"));
    expect(
      (await prisma.missingItem.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("EN_BODEGA");
  });

  it("una segunda llamada secuencial tampoco duplica", async () => {
    const id = await nuevoFaltante("PEDIDO");

    expect(await marcar(id)).toBe(1);
    expect(await marcar(id)).toBe(0);

    const fila = await prisma.missingItem.findUniqueOrThrow({ where: { id } });
    expect(fila.status).toBe("EN_BODEGA");
  });
});

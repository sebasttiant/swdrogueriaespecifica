import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { registerInventoryEntry } from "@/server/services/inventory-entry.service";
import { deliverPending, registerPending } from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// ENTREGAR CIERRA EL RIEL, igual que cancelar.
//
// Un pedido de cliente y su `MissingItem` son dos filas que mueren por caminos
// distintos. `cancelPendingCommitment` y el cierre parcial ya cancelaban el riel
// en su misma transacción. La entrega no lo hacía, y ese hueco dejaba faltantes
// abiertos para siempre: medido en producción el 2026-09-07, 13 de los 16 que
// contaba el chip de abastecimiento colgaban de pedidos ya ENTREGADOS.
//
// Y no era solo un número. Un riel abierto sigue siendo candidato del cierre
// FIFO, así que la próxima entrada de ese producto le reserva stock a un pedido
// que ya se entregó: mercadería en el estante que nadie puede vender. Eso es lo
// que prueba el último test, y por eso este archivo va contra PostgreSQL real:
// la asignación FIFO es SQL con `FOR UPDATE`, no lógica de aplicación.
// --------------------------------------------------------------------------

let productId = "";
let sellerId = "";

beforeAll(async () => {
  const seller = await prisma.user.create({
    data: { email: `entrega-riel-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  sellerId = seller.id;

  const product = await prisma.product.create({
    data: {
      orionCode: `ORN-ER-${Date.now()}`,
      code: `ER-${Date.now()}`,
      name: "Pediasure 900g",
      unit: "unidad",
    },
  });
  productId = product.id;
});

afterEach(async () => {
  await prisma.notificationOutbox.deleteMany({ where: { recipientId: sellerId } });
  await prisma.pendingInventoryReservation.deleteMany({
    where: { batch: { productId } },
  });
  await prisma.inventoryAllocation.deleteMany({ where: { missingItem: { productId } } });
  await prisma.pendingDelivery.deleteMany({ where: { pending: { productId } } });
  await prisma.missingItem.deleteMany({ where: { productId } });
  await prisma.inventoryEntry.deleteMany({ where: { productId } });
  await prisma.productBatch.deleteMany({ where: { productId } });
  await prisma.pending.deleteMany({ where: { productId } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.user.deleteMany({ where: { id: sellerId } });
});

function entrada(quantity: number) {
  return registerInventoryEntry({
    productId,
    quantity,
    batchCode: `L-${randomUUID().slice(0, 8)}`,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    createdById: sellerId,
    idempotencyKey: randomUUID(),
  });
}

function nuevoPedido(quantity: number) {
  return registerPending({
    productId,
    quantity,
    promisedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    customerName: "Cliente",
    customerPhone: "3001234567",
    createdById: sellerId,
    idempotencyKey: randomUUID(),
  });
}

/**
 * La forma exacta que se encontró 13 veces en producción: el pedido está listo
 * para entregarse y ADEMÁS arrastra un riel abierto.
 *
 * El pendiente se arma escribiendo su estado, que es el idioma que ya usa
 * `pending-delivery-inventory.pg.test.ts` para el paso de entrega: llegar acá
 * por el flujo natural exige facturación, reservas y entradas parciales que no
 * son lo que este archivo protege. Lo que se prueba es la transición: al
 * entregar, ese riel tiene que cerrarse.
 */
async function pedidoConRielColgando(quantity: number) {
  const batch = await prisma.productBatch.create({
    data: {
      productId,
      batchCode: `L-${randomUUID().slice(0, 8)}`,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      quantity: 100,
    },
  });

  const pending = await prisma.pending.create({
    data: {
      productId,
      quantity,
      promisedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdById: sellerId,
      status: "PENDIENTE",
      // Facturado: `validateDelivery` exige la factura antes de entregar.
      customerStatus: "FACTURADO",
      invoicedQuantity: quantity,
      inventoryReadyQuantity: quantity,
      reservedInventoryQuantity: quantity,
    },
  });

  await prisma.pendingInventoryReservation.create({
    data: { pendingId: pending.id, batchId: batch.id, quantity },
  });

  const riel = await prisma.missingItem.create({
    data: { productId, quantity, status: "FALTANTE", originId: pending.id, createdById: sellerId },
  });

  return { pending, riel };
}

describe("la entrega cierra el riel", () => {
  it("entregar TODO lo cancela", async () => {
    const { pending, riel } = await pedidoConRielColgando(6);

    const entrega = await deliverPending({
      id: pending.id,
      quantity: 6,
      deliveredById: sellerId,
      canManageAll: true,
    });
    expect(entrega.rejection).toBeNull();
    expect(entrega.pending?.status).toBe("ENTREGADO");

    const fila = await prisma.missingItem.findUniqueOrThrow({ where: { id: riel.id } });
    expect(fila.status).toBe("CANCELADO");
  });

  // La otra mitad de la regla, y la que importa no romper: si el cliente
  // todavía espera el resto, el riel es exactamente lo que hay que conservar.
  it("una entrega PARCIAL lo deja abierto", async () => {
    const { pending, riel } = await pedidoConRielColgando(6);

    const parcial = await deliverPending({
      id: pending.id,
      quantity: 2,
      deliveredById: sellerId,
      canManageAll: true,
    });
    expect(parcial.rejection).toBeNull();
    expect(parcial.pending?.status).toBe("PARCIAL");

    const fila = await prisma.missingItem.findUniqueOrThrow({ where: { id: riel.id } });
    expect(fila.status).toBe("FALTANTE");
  });

  // EL DAÑO REAL, no el cosmético: mientras el riel siguiera abierto, la
  // siguiente entrada del producto lo agarraba por antigüedad y le reservaba
  // stock a un pedido ya entregado. Stock que está en el estante y que el
  // sistema da por comprometido con alguien que ya se fue con su mercadería.
  it("después de entregar, una entrada nueva ya no le reserva stock", async () => {
    const { pending } = await pedidoConRielColgando(6);
    await deliverPending({
      id: pending.id,
      quantity: 6,
      deliveredById: sellerId,
      canManageAll: true,
    });

    await entrada(10);

    const fila = await prisma.pending.findUniqueOrThrow({ where: { id: pending.id } });
    const reservas = await prisma.pendingInventoryReservation.aggregate({
      where: { pendingId: pending.id },
      _sum: { quantity: true },
    });

    expect(fila.status).toBe("ENTREGADO");
    // La entrega consumió lo suyo y no quedó nada apartado para un pedido
    // terminado: las 10 unidades nuevas entran libres, para vender.
    expect(reservas._sum.quantity ?? 0).toBe(0);
  });
});

// --------------------------------------------------------------------------
// LA LIMPIEZA DE LO QUE EL DEFECTO YA DEJÓ.
//
// Arreglar el código no cierra los rieles que quedaron abiertos: al 2026-09-07
// eran 13 en producción. La migración los cierra, y se prueba SOBRE FILAS
// REALES —un `UPDATE` que no matchea nada pasa igual de verde que uno correcto,
// y eso no probaría nada—.
// --------------------------------------------------------------------------
describe("la migración que cierra los rieles ya huérfanos", () => {
  const SQL = readFileSync(
    resolve(
      process.cwd(),
      "prisma/migrations/20260907190000_close_rails_of_terminal_pendings/migration.sql",
    ),
    "utf8",
  );

  async function correrMigracion() {
    for (const statement of SQL.replace(/--[^\n]*/g, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await prisma.$executeRawUnsafe(statement);
    }
  }

  async function rielDe(estadoPedido: "ENTREGADO" | "PENDIENTE", estadoRiel = "FALTANTE") {
    const { pending } = await nuevoPedido(3);
    await prisma.pending.update({
      where: { id: pending.id },
      data: { status: estadoPedido },
    });
    const riel = await prisma.missingItem.create({
      data: {
        productId,
        quantity: 3,
        status: estadoRiel as "FALTANTE",
        originId: pending.id,
        createdById: sellerId,
      },
    });
    return riel.id;
  }

  it("cierra el riel abierto de un pedido terminal", async () => {
    const id = await rielDe("ENTREGADO");

    await correrMigracion();

    expect((await prisma.missingItem.findUniqueOrThrow({ where: { id } })).status).toBe(
      "CANCELADO",
    );
  });

  it("no toca el de un pedido todavía vivo", async () => {
    const id = await rielDe("PENDIENTE");

    await correrMigracion();

    expect((await prisma.missingItem.findUniqueOrThrow({ where: { id } })).status).toBe(
      "FALTANTE",
    );
  });

  // Un riel que YA se resolvió conserva su historia: cancelarlo encima borraría
  // el hecho de que la mercadería llegó.
  it("no pisa un riel ya recibido", async () => {
    const id = await rielDe("ENTREGADO", "RECIBIDO");

    await correrMigracion();

    expect((await prisma.missingItem.findUniqueOrThrow({ where: { id } })).status).toBe(
      "RECIBIDO",
    );
  });
});

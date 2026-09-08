import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { countOverdueMissingItems } from "@/server/repositories/missing-item.repository";
import { countOverduePendings } from "@/server/repositories/pending.repository";
import {
  countPendingReception,
  listPendingReception,
} from "@/server/services/pending-reception.service";
import {
  cancelPendingCommitment,
  registerPending,
  setPendingManagementStatus,
} from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// LA ALERTA CUENTA TRABAJO QUE TODAVÍA SE PUEDE HACER.
//
// Un pedido de cliente sin stock deja dos filas vivas: el `Pending` —la promesa
// a la persona— y el `MissingItem` que es el riel para conseguirlo. Las dos
// mueren por caminos distintos, y ahí estaba el defecto: el riel podía quedar
// abierto y vencido durante meses colgando de un pedido que ya se entregó o que
// gerencia declaró agotado. El chip rojo contaba eso como trabajo urgente.
//
// Va contra PostgreSQL real porque lo que se prueba ES la consulta: un filtro
// sobre la relación (`origin`) y sobre dos columnas de estado distintas. Un
// mock del cliente Prisma solo probaría que el objeto literal no cambió.
// --------------------------------------------------------------------------

let productId = "";
let sellerId = "";

const HACE_DOS_DIAS = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const EN_DOS_DIAS = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  const seller = await prisma.user.create({
    data: { email: `abastecimiento-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  sellerId = seller.id;

  const product = await prisma.product.create({
    data: {
      orionCode: `ORN-AB-${Date.now()}`,
      code: `AB-${Date.now()}`,
      name: "Ensure Advance 850g",
      unit: "unidad",
    },
  });
  productId = product.id;
});

afterEach(async () => {
  await prisma.notificationOutbox.deleteMany({ where: { recipientId: sellerId } });
  await prisma.missingItem.deleteMany({ where: { productId } });
  await prisma.pending.deleteMany({ where: { productId } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.user.deleteMany({ where: { id: sellerId } });
});

/**
 * Un pedido SIN stock: nace con su riel en FALTANTE.
 *
 * La fecha prometida se corrige después de crearlo. El alta valida contra el
 * reloj —prometerle a un cliente una fecha ya pasada no es un caso real— y lo
 * que este archivo necesita probar es justamente el vencido.
 */
async function pedidoSinStock(options?: { vencido?: boolean }) {
  const { pending, missingItem } = await registerPending({
    productId,
    quantity: 4,
    promisedAt: EN_DOS_DIAS(),
    customerName: "Cliente",
    customerPhone: "3001234567",
    createdById: sellerId,
    idempotencyKey: randomUUID(),
  });

  if (options?.vencido !== false) {
    await prisma.pending.update({
      where: { id: pending.id },
      data: { promisedAt: HACE_DOS_DIAS() },
    });
  }

  return { pending, missingItem };
}

/** Los tres números que tienen que contar lo mismo. */
async function tablero() {
  const [chip, cola, colaVencida, atrasadas] = await Promise.all([
    countOverdueMissingItems(),
    countPendingReception(),
    listPendingReception({ overdueOnly: true }),
    countOverduePendings(),
  ]);
  return { chip, cola, colaVencida: colaVencida.length, atrasadas };
}

describe("un pedido que todavía se puede conseguir", () => {
  it("vencido: entra al chip, a la cola y a atrasadas", async () => {
    const { pending } = await pedidoSinStock();

    const { chip, cola, colaVencida, atrasadas } = await tablero();
    expect(chip).toBe(1);
    expect(cola).toBe(1);
    expect(colaVencida).toBe(1);
    expect(atrasadas).toBe(1);

    // Y la fila que abre el chip es la del pedido que lo generó: el número y la
    // pantalla hablan de lo mismo.
    const filas = await listPendingReception({ overdueOnly: true });
    expect(filas[0]?.pendingId).toBe(pending.id);
  });

  it("con fecha futura: sigue en la cola, pero NO en el chip rojo", async () => {
    await pedidoSinStock({ vencido: false });

    const { chip, cola, atrasadas } = await tablero();
    expect(chip).toBe(0);
    expect(cola).toBe(1);
    expect(atrasadas).toBe(0);
  });
});

// --------------------------------------------------------------------------
// EL AGOTADO. Gerencia decidió que no se consigue: no hay acción de
// abastecimiento posible, y el pendiente igual sigue vivo porque al cliente hay
// que responderle por el flujo del vendedor.
//
// Se marca en `purchaseStatus`, NO en `status` —así lo escribe
// `updatePendingManagementStatus` desde la migración que separó los dos ejes—.
// La lista de estados alertables miraba solo `status`, así que la exclusión no
// alcanzaba a ningún agotado nuevo: ni en este chip ni en el de Atrasadas.
// --------------------------------------------------------------------------
describe("un pedido agotado", () => {
  // LA DISTINCIÓN QUE SOSTIENE TODO ESTE ARCHIVO: se apaga la ALARMA, no la
  // cola de trabajo. Bodega lo sigue viendo, y si la caja aparece igual puede
  // recibirla; el chip rojo deja de contarlo porque ya no hay nada que apurar.
  it("sale de los dos chips rojos, pero NO de la cola de bodega", async () => {
    const { pending } = await pedidoSinStock();
    expect((await tablero()).chip).toBe(1);

    const { rejection } = await setPendingManagementStatus({
      id: pending.id,
      status: "AGOTADO",
    });
    expect(rejection).toBeNull();

    const { chip, cola, colaVencida, atrasadas } = await tablero();
    expect(chip).toBe(0);
    expect(colaVencida).toBe(0);
    expect(atrasadas).toBe(0);
    expect(cola).toBe(1);
  });

  it("el riel NO se cancela en la base: el dato queda, deja de gritar", async () => {
    const { pending, missingItem } = await pedidoSinStock();

    await setPendingManagementStatus({ id: pending.id, status: "AGOTADO" });

    // Filtrar no es borrar. Si gerencia vuelve a mover el pedido, el riel sigue
    // ahí con su historia; y si entra mercadería, la conciliación FIFO —que
    // consulta `missing_items` por su cuenta— lo cierra igual.
    //
    // Por eso el arreglo es un filtro y no una cascada que cancele el riel:
    // apagar la alarma no puede perder el dato.
    const fila = await prisma.missingItem.findUniqueOrThrow({
      where: { id: missingItem!.id },
    });
    expect(fila.status).toBe("FALTANTE");
  });

  it("vuelve a contar si gerencia lo reactiva", async () => {
    const { pending } = await pedidoSinStock();
    await setPendingManagementStatus({ id: pending.id, status: "AGOTADO" });
    expect((await tablero()).chip).toBe(0);

    await setPendingManagementStatus({
      id: pending.id,
      status: "BUSQUEDA",
      expectedStatus: "AGOTADO",
    });

    expect((await tablero()).chip).toBe(1);
  });
});

// --------------------------------------------------------------------------
// LOS TERMINALES. El pedido ya no existe como compromiso.
//
// Cancelar y cerrar parcial YA cancelaban el riel en la misma transacción, así
// que nunca inflaron el número: el primer test lo deja probado en vez de
// asumido. Entregar NO lo hace —`deliverPending` no toca `missingItem`—, y ese
// es el agujero por el que se colaba trabajo fantasma.
//
// El ENTREGADO se arma escribiendo el estado terminal: llegar ahí por el flujo
// real exige un enredo de stock y reservas que no es lo que este archivo
// protege. Lo que se prueba es la consulta, y la consulta lee esta fila igual
// que leería la de producción.
// --------------------------------------------------------------------------
describe("un pedido terminal", () => {
  it("cancelado: el propio flujo cancela el riel, no hace falta filtrarlo", async () => {
    const { pending, missingItem } = await pedidoSinStock();

    await cancelPendingCommitment({
      id: pending.id,
      cancelledById: sellerId,
      canManageAll: true,
    });

    const fila = await prisma.missingItem.findUniqueOrThrow({
      where: { id: missingItem!.id },
    });
    expect(fila.status).toBe("CANCELADO");

    const { chip, cola, atrasadas } = await tablero();
    expect(chip).toBe(0);
    expect(cola).toBe(0);
    expect(atrasadas).toBe(0);
  });

  it.each(["ENTREGADO", "CLOSED_PARTIAL"] as const)(
    "%s: el riel abierto deja de contar como trabajo urgente",
    async (status) => {
      const { pending, missingItem } = await pedidoSinStock();

      await prisma.pending.update({ where: { id: pending.id }, data: { status } });

      // El riel sigue abierto en la base —nadie lo cerró— y aun así no aparece.
      const fila = await prisma.missingItem.findUniqueOrThrow({
        where: { id: missingItem!.id },
      });
      expect(fila.status).toBe("FALTANTE");

      // Acá SÍ sale de todos lados, y la diferencia con el agotado es el
      // motivo: un pedido terminal no tiene a nadie esperando. El agotado sí.
      const { chip, cola, colaVencida, atrasadas } = await tablero();
      expect(chip).toBe(0);
      expect(cola).toBe(0);
      expect(colaVencida).toBe(0);
      expect(atrasadas).toBe(0);
    },
  );
});

// --------------------------------------------------------------------------
// LO QUE NO CAMBIA. Las dos exclusiones que ya existían siguen en pie: un riel
// confirmado dejó de ser trabajo, y uno de estantería nunca fue de esta cola.
// --------------------------------------------------------------------------
describe("las exclusiones de siempre", () => {
  it("un riel confirmado no cuenta", async () => {
    const { missingItem } = await pedidoSinStock();

    await prisma.missingItem.update({
      where: { id: missingItem!.id },
      data: { confirmedAt: new Date() },
    });

    const { chip, cola } = await tablero();
    expect(chip).toBe(0);
    expect(cola).toBe(0);
  });

  it("un faltante de estantería no entra: no le prometió nada a nadie", async () => {
    await prisma.missingItem.create({
      data: { productId, quantity: 3, status: "FALTANTE", createdById: sellerId },
    });

    const { chip, cola } = await tablero();
    expect(chip).toBe(0);
    expect(cola).toBe(0);
  });
});

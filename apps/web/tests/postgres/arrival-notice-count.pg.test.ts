import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  countArrivalNotices,
  listArrivalNotices,
} from "@/server/services/arrival-notice.service";
import {
  AGGREGATE_TYPE_PENDING,
  NOTIFICATION_EVENT,
} from "@/server/services/notification-outbox.service";

// --------------------------------------------------------------------------
// El contador de la barra tiene que hablar del MISMO conjunto que la lista.
//
// La barra se pinta en TODAS las pantallas. Si contara distinto que
// `/pendientes`, el vendedor vería "llegaron 2", entraría, y encontraría una
// sola: aprendería a desconfiar del aviso, y un aviso en el que no se confía
// es peor que no tenerlo, porque te deja creyendo que avisaste.
//
// Por eso el contador NO reimplementa la consulta: comparte exactamente los
// mismos filtros. Estas pruebas son la prueba de que siguen coincidiendo.
//
// Van contra PostgreSQL real porque lo que se afirma es el comportamiento de
// un JOIN con agregación y de los filtros de estado; un doble diría que sí a
// cualquier cosa.
// --------------------------------------------------------------------------

const RUN = randomUUID().slice(0, 8);
let vendedorId = "";
let otroVendedorId = "";
let productId = "";
const pendientes: string[] = [];

beforeAll(async () => {
  const [vendedor, otro, product] = await Promise.all([
    prisma.user.create({
      data: {
        email: `vendedor-${RUN}@test.local`,
        name: `Vendedor ${RUN}`,
        passwordHash: "x",
        role: "OPERADOR",
      },
    }),
    prisma.user.create({
      data: {
        email: `otro-${RUN}@test.local`,
        name: `Otro ${RUN}`,
        passwordHash: "x",
        role: "OPERADOR",
      },
    }),
    prisma.product.create({
      data: { code: `CNT-${RUN}`, name: `Producto ${RUN}`, unit: "unidad" },
    }),
  ]);
  vendedorId = vendedor.id;
  otroVendedorId = otro.id;
  productId = product.id;
});

/** Encola un aviso en el outbox con los campos que el modelo exige. */
async function avisar(
  pendingId: string,
  recipientId: string,
  eventType: string,
): Promise<void> {
  await prisma.notificationOutbox.create({
    data: {
      aggregateType: AGGREGATE_TYPE_PENDING,
      aggregateId: pendingId,
      recipientId,
      eventType,
      transitionKey: eventType,
      fingerprint: `${pendingId}:${eventType}`,
      payload: {},
    },
  });
}

async function pendienteAvisado(opts: {
  ownerId?: string;
  status?: "PENDIENTE" | "PARCIAL" | "ENTREGADO";
  availability?: "DISPONIBLE_COMPLETO" | "DISPONIBLE_PARCIAL" | "ESPERANDO";
  conAviso?: boolean;
} = {}) {
  const pending = await prisma.pending.create({
    data: {
      productId,
      quantity: 10,
      promisedAt: new Date("2026-09-01T15:00:00Z"),
      customerName: `Cliente ${RUN}`,
      createdById: opts.ownerId ?? vendedorId,
      purchaseStatus: "SOLICITADO",
      customerStatus: "POR_CONTACTAR",
      status: opts.status ?? "PENDIENTE",
      availabilityStatus: opts.availability ?? "DISPONIBLE_COMPLETO",
      inventoryReadyQuantity: 10,
    },
  });
  pendientes.push(pending.id);

  if (opts.conAviso !== false) {
    await avisar(pending.id, opts.ownerId ?? vendedorId, NOTIFICATION_EVENT.pendingAvailabilityFull);
  }
  return pending.id;
}

afterEach(async () => {
  const ids = pendientes.splice(0);
  await prisma.notificationOutbox.deleteMany({ where: { aggregateId: { in: ids } } });
  await prisma.pending.deleteMany({ where: { id: { in: ids } } });
});

describe("contador de avisos de llegada", () => {
  it("cuenta lo mismo que la lista", async () => {
    await pendienteAvisado();
    await pendienteAvisado();

    const [total, lista] = await Promise.all([
      countArrivalNotices(vendedorId),
      listArrivalNotices(vendedorId),
    ]);

    expect(total).toBe(lista.length);
    expect(total).toBe(2);
  });

  it("sin avisos devuelve cero", async () => {
    expect(await countArrivalNotices(vendedorId)).toBe(0);
  });

  // El aviso le habla al responsable. Contar los ajenos le mostraría al
  // vendedor un número que no puede resolver, y lo mandaría a buscar algo que
  // no es suyo.
  it("NO cuenta los avisos de otro vendedor", async () => {
    await pendienteAvisado({ ownerId: otroVendedorId });

    expect(await countArrivalNotices(vendedorId)).toBe(0);
    expect(await countArrivalNotices(otroVendedorId)).toBe(1);
  });

  // El aviso se limpia con la ACCIÓN, no con un temporizador: cuando el
  // vendedor entrega, el pendiente sale del filtro de estado y el aviso
  // desaparece solo. Por eso no hace falta un "posponer".
  it("deja de contar cuando el pendiente se entrega", async () => {
    const id = await pendienteAvisado();
    expect(await countArrivalNotices(vendedorId)).toBe(1);

    await prisma.pending.update({ where: { id }, data: { status: "ENTREGADO" } });

    expect(await countArrivalNotices(vendedorId)).toBe(0);
  });

  it("no cuenta un pendiente sin stock disponible", async () => {
    await pendienteAvisado({ availability: "ESPERANDO" });

    expect(await countArrivalNotices(vendedorId)).toBe(0);
  });

  // Dos eventos sobre el mismo pendiente —parcial y después completo— son UN
  // aviso, no dos. La lista agrupa por pendiente; el contador tiene que hacer
  // lo mismo o el número quedaría inflado.
  it("dos eventos del mismo pendiente cuentan como uno", async () => {
    const id = await pendienteAvisado();
    await avisar(id, vendedorId, NOTIFICATION_EVENT.pendingAvailabilityPartial);

    expect(await countArrivalNotices(vendedorId)).toBe(1);
  });
});

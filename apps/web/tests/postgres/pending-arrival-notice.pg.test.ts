import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { enqueuePendingAvailabilityNotification } from "@/server/services/notification-outbox.service";
import { listArrivalNotices } from "@/server/services/arrival-notice.service";

// --------------------------------------------------------------------------
// El aviso al vendedor de que su pendiente ya tiene mercadería.
//
// La cadena hasta acá estaba construida y era INVISIBLE: la entrada encola el
// evento dentro de su transacción, pero ninguna pantalla, acción ni servicio
// leía la bandeja. El aviso se escribía en la base y el vendedor no lo veía
// nunca.
//
// Se prueba contra PostgreSQL real porque lo que decide qué se muestra es el
// cruce entre el evento encolado y el estado ACTUAL del pendiente, y eso es una
// consulta, no una regla pura.
// --------------------------------------------------------------------------

let productId = "";
let vendedorId = "";
let otroVendedorId = "";

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `AVI-${Date.now()}`, name: "Amoxicilina 500mg", unit: "caja" },
  });
  productId = product.id;

  const vendedor = await prisma.user.create({
    data: { email: `vend-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  vendedorId = vendedor.id;

  const otro = await prisma.user.create({
    data: { email: `otro-${randomUUID()}@test.local`, name: "Otro vendedor" },
  });
  otroVendedorId = otro.id;
});

afterEach(async () => {
  await prisma.notificationOutbox.deleteMany({
    where: { recipientId: { in: [vendedorId, otroVendedorId] } },
  });
  await prisma.pending.deleteMany({ where: { productId } });
});

type EstadoPendiente = {
  createdById: string;
  availabilityStatus?: "ESPERANDO" | "LLEGO_BODEGA" | "DISPONIBLE_PARCIAL" | "DISPONIBLE_COMPLETO";
  status?: "PENDIENTE" | "PARCIAL" | "ENTREGADO" | "CANCELADO" | "CLOSED_PARTIAL";
  customerName?: string;
};

async function nuevoPendiente(estado: EstadoPendiente): Promise<string> {
  const pending = await prisma.pending.create({
    data: {
      productId,
      quantity: 3,
      promisedAt: new Date("2026-09-01T15:00:00Z"),
      createdById: estado.createdById,
      purchaseStatus: "SOLICITADO",
      availabilityStatus: estado.availabilityStatus ?? "ESPERANDO",
      customerStatus: "POR_CONTACTAR",
      ...(estado.status ? { status: estado.status } : {}),
      ...(estado.customerName ? { customerName: estado.customerName } : {}),
    },
  });
  return pending.id;
}

/** Encola el aviso y deja el pendiente en el estado que ese aviso describe. */
async function bodegaInforma(
  pendingId: string,
  availabilityStatus: "DISPONIBLE_PARCIAL" | "DISPONIBLE_COMPLETO",
): Promise<void> {
  await prisma.pending.update({
    where: { id: pendingId },
    data: {
      availabilityStatus,
      inventoryReadyQuantity: availabilityStatus === "DISPONIBLE_COMPLETO" ? 3 : 1,
    },
  });
  await enqueuePendingAvailabilityNotification({ pendingId, availabilityStatus });
}

describe("listArrivalNotices · lo que el vendedor tiene que ver", () => {
  it("muestra el aviso cuando bodega informó que llegó completo", async () => {
    const pendingId = await nuevoPendiente({
      createdById: vendedorId,
      customerName: "Doña Marta",
    });
    await bodegaInforma(pendingId, "DISPONIBLE_COMPLETO");

    const avisos = await listArrivalNotices(vendedorId);

    expect(avisos).toHaveLength(1);
    expect(avisos[0]?.pendingId).toBe(pendingId);
    expect(avisos[0]?.availabilityStatus).toBe("DISPONIBLE_COMPLETO");
    expect(avisos[0]?.productName).toBe("Amoxicilina 500mg");
    expect(avisos[0]?.quantity).toBe(3);
    expect(avisos[0]?.readyQuantity).toBe(3);
  });

  it("distingue el parcial del completo", async () => {
    const pendingId = await nuevoPendiente({ createdById: vendedorId });
    await bodegaInforma(pendingId, "DISPONIBLE_PARCIAL");

    const avisos = await listArrivalNotices(vendedorId);

    expect(avisos).toHaveLength(1);
    expect(avisos[0]?.availabilityStatus).toBe("DISPONIBLE_PARCIAL");
    expect(avisos[0]?.readyQuantity).toBe(1);
  });

  it("NO le muestra a un vendedor los pendientes de otro", async () => {
    const ajeno = await nuevoPendiente({ createdById: otroVendedorId });
    await bodegaInforma(ajeno, "DISPONIBLE_COMPLETO");

    const avisos = await listArrivalNotices(vendedorId);

    expect(avisos).toHaveLength(0);
  });

  it("no muestra nada cuando bodega todavía no informó", async () => {
    await nuevoPendiente({ createdById: vendedorId });

    const avisos = await listArrivalNotices(vendedorId);

    expect(avisos).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// El aviso se limpia solo.
//
// No hay columna de "leído" y no se agrega una: el aviso deja de ser relevante
// cuando el vendedor hizo lo que el aviso le pedía. Atarlo al estado ACTUAL del
// pendiente es más honesto que una marca aparte, que puede quedar en `false`
// sobre un pendiente ya entregado y seguir gritando para siempre.
// --------------------------------------------------------------------------
describe("listArrivalNotices · deja de avisar cuando ya no hace falta", () => {
  it.each([
    ["ENTREGADO"],
    ["CANCELADO"],
    ["CLOSED_PARTIAL"],
  ] as const)("desaparece cuando el pendiente quedó en %s", async (estadoFinal) => {
    const pendingId = await nuevoPendiente({ createdById: vendedorId });
    await bodegaInforma(pendingId, "DISPONIBLE_COMPLETO");

    await prisma.pending.update({
      where: { id: pendingId },
      data: { status: estadoFinal },
    });

    const avisos = await listArrivalNotices(vendedorId);

    expect(avisos).toHaveLength(0);
  });

  it("sigue avisando mientras el pendiente está abierto", async () => {
    const pendingId = await nuevoPendiente({ createdById: vendedorId });
    await bodegaInforma(pendingId, "DISPONIBLE_COMPLETO");

    await prisma.pending.update({
      where: { id: pendingId },
      data: { status: "PARCIAL" },
    });

    const avisos = await listArrivalNotices(vendedorId);

    expect(avisos).toHaveLength(1);
  });

  // El evento queda en el outbox para siempre —es el registro de que bodega
  // informó—, pero si alguien revierte la disponibilidad el aviso no puede
  // seguir en pantalla diciendo que hay stock que ya no está.
  it("desaparece si la disponibilidad volvió a ESPERANDO", async () => {
    const pendingId = await nuevoPendiente({ createdById: vendedorId });
    await bodegaInforma(pendingId, "DISPONIBLE_COMPLETO");

    await prisma.pending.update({
      where: { id: pendingId },
      data: { availabilityStatus: "ESPERANDO", inventoryReadyQuantity: 0 },
    });

    const avisos = await listArrivalNotices(vendedorId);

    expect(avisos).toHaveLength(0);
  });
});

describe("listArrivalNotices · orden y techo", () => {
  it("primero el que llegó hace más tiempo: el cliente que esperó más va primero", async () => {
    const viejo = await nuevoPendiente({ createdById: vendedorId });
    await bodegaInforma(viejo, "DISPONIBLE_COMPLETO");
    const nuevo = await nuevoPendiente({ createdById: vendedorId });
    await bodegaInforma(nuevo, "DISPONIBLE_COMPLETO");

    const avisos = await listArrivalNotices(vendedorId);

    expect(avisos.map((a) => a.pendingId)).toEqual([viejo, nuevo]);
  });

  it("respeta un techo: la pantalla no puede crecer sin límite", async () => {
    for (let i = 0; i < 7; i += 1) {
      const id = await nuevoPendiente({ createdById: vendedorId });
      await bodegaInforma(id, "DISPONIBLE_COMPLETO");
    }

    const avisos = await listArrivalNotices(vendedorId, { limit: 5 });

    expect(avisos).toHaveLength(5);
  });
});

// --------------------------------------------------------------------------
// El historial NO puede tapar un aviso vivo.
//
// La consulta leía los 50 eventos más nuevos de la persona y recién después
// descartaba los de pendientes cerrados. Un vendedor con volumen —60 pedidos
// atendidos esta semana— dejaba de ver al cliente que espera desde el lunes:
// los eventos nuevos gastaban el cupo y el aviso vivo quedaba afuera. Fallaba
// en silencio, y justo cuando más movimiento hay.
// --------------------------------------------------------------------------
describe("listArrivalNotices · el historial no tapa lo vivo", () => {
  it("muestra el aviso vivo aunque haya 60 eventos posteriores de pendientes cerrados", async () => {
    const vivo = await nuevoPendiente({ createdById: vendedorId });
    await bodegaInforma(vivo, "DISPONIBLE_COMPLETO");

    // 60 pendientes que llegaron DESPUÉS y ya se entregaron: sus eventos son
    // más nuevos y antes consumían el cupo de lectura.
    for (let i = 0; i < 60; i += 1) {
      const cerrado = await nuevoPendiente({ createdById: vendedorId });
      await bodegaInforma(cerrado, "DISPONIBLE_COMPLETO");
      await prisma.pending.update({
        where: { id: cerrado },
        data: { status: "ENTREGADO" },
      });
    }

    const avisos = await listArrivalNotices(vendedorId);

    expect(avisos.map((a) => a.pendingId)).toContain(vivo);
  });

  it("devuelve como mucho el techo pedido, y son los más antiguos", async () => {
    const creados: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      const id = await nuevoPendiente({ createdById: vendedorId });
      await bodegaInforma(id, "DISPONIBLE_COMPLETO");
      creados.push(id);
    }

    const avisos = await listArrivalNotices(vendedorId);

    expect(avisos).toHaveLength(10);
    expect(avisos.map((a) => a.pendingId)).toEqual(creados.slice(0, 10));
  });

  // El estado del pendiente NO alcanza: el aviso existe porque bodega informó.
  // Fabricarlo desde la disponibilidad sola inventaría un aviso que nadie emitió.
  it("no inventa un aviso si el evento nunca se encoló", async () => {
    const sinEvento = await nuevoPendiente({ createdById: vendedorId });
    await prisma.pending.update({
      where: { id: sinEvento },
      data: { availabilityStatus: "DISPONIBLE_COMPLETO", inventoryReadyQuantity: 3 },
    });

    const avisos = await listArrivalNotices(vendedorId);

    expect(avisos.map((a) => a.pendingId)).not.toContain(sinEvento);
  });
});

// --------------------------------------------------------------------------
// Transiciones repetidas sobre el mismo pendiente dejan UN solo aviso.
//
// Quien deduplica es el índice único de transición del outbox, no el código.
// Estas llamadas son SECUENCIALES: prueban la deduplicación, no la
// concurrencia. Demostrar que dos entradas simultáneas se comportan bien exige
// barreras entre transacciones, y eso no está acá — decirlo importa, porque una
// prueba mal nombrada da por cubierto algo que nadie verificó.
// --------------------------------------------------------------------------
describe("listArrivalNotices · transiciones repetidas", () => {
  it("dos avisos de la misma transición dejan UN solo aviso", async () => {
    const pendingId = await nuevoPendiente({ createdById: vendedorId });

    // La segunda transición idéntica choca contra el único y no duplica.
    await bodegaInforma(pendingId, "DISPONIBLE_PARCIAL");
    await bodegaInforma(pendingId, "DISPONIBLE_PARCIAL");

    const avisos = await listArrivalNotices(vendedorId);

    expect(avisos.filter((a) => a.pendingId === pendingId)).toHaveLength(1);
  });

  // Parcial y completo son transiciones distintas: quedan dos eventos, pero el
  // aviso es uno y `noticedAt` es el del PRIMERO — cuándo empezó la espera.
  it("parcial y luego completo dejan UN aviso, fechado en el primero", async () => {
    const pendingId = await nuevoPendiente({ createdById: vendedorId });

    await bodegaInforma(pendingId, "DISPONIBLE_PARCIAL");
    const primero = await prisma.notificationOutbox.findFirstOrThrow({
      where: { aggregateId: pendingId },
      orderBy: { createdAt: "asc" },
    });
    await bodegaInforma(pendingId, "DISPONIBLE_COMPLETO");

    const avisos = await listArrivalNotices(vendedorId);
    const aviso = avisos.find((a) => a.pendingId === pendingId);

    expect(avisos.filter((a) => a.pendingId === pendingId)).toHaveLength(1);
    expect(aviso?.availabilityStatus).toBe("DISPONIBLE_COMPLETO");
    expect(aviso?.noticedAt.getTime()).toBe(primero.createdAt.getTime());
  });
});

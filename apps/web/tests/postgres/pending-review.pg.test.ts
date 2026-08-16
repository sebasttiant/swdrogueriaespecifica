import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { listPendings } from "@/server/repositories/pending.repository";

// Los filtros de eje se prueban contra PostgreSQL real porque lo que se está
// verificando es cómo se COMBINAN en la consulta: que dos ejes juntos
// intersequen en vez de unir, que el recorte por dueño siga vigente cuando hay
// filtros, y que un cursor de otra vista no arrastre filas que el filtro
// excluye. Un doble en memoria devuelve lo que el test le pida y no prueba
// ninguna de las tres.

let productId = "";
let ownerId = "";
let otherOwnerId = "";

type Axes = {
  purchase?: "POR_PEDIR" | "SOLICITADO" | "BUSQUEDA" | "COTIZANDO" | "AGOTADO";
  availability?: "ESPERANDO" | "LLEGO_BODEGA" | "DISPONIBLE_PARCIAL" | "DISPONIBLE_COMPLETO";
  customer?: "POR_CONTACTAR" | "CONTACTADO" | "FACTURADO" | "ENTREGADO" | "CANCELADO";
};

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `REV-${Date.now()}`, name: "Losartán", unit: "unidad" },
  });
  productId = product.id;

  const owner = await prisma.user.create({
    data: { email: `duenio-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  ownerId = owner.id;

  const otherOwner = await prisma.user.create({
    data: { email: `otro-${randomUUID()}@test.local`, name: "Otro vendedor" },
  });
  otherOwnerId = otherOwner.id;
});

afterEach(async () => {
  await prisma.pending.deleteMany({ where: { productId } });
});

/**
 * Un pendiente abierto con los ejes indicados.
 *
 * `createdAt` explícito y separado: el listado ordena por fecha descendente y
 * dos filas creadas en el mismo milisegundo harían la paginación impredecible.
 */
async function newPending(
  axes: Axes,
  options: { owner?: string; createdAt?: Date } = {},
): Promise<string> {
  const pending = await prisma.pending.create({
    data: {
      productId,
      quantity: 1,
      promisedAt: new Date("2026-09-01T15:00:00Z"),
      createdById: options.owner ?? ownerId,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      ...(axes.purchase ? { purchaseStatus: axes.purchase } : {}),
      ...(axes.availability ? { availabilityStatus: axes.availability } : {}),
      ...(axes.customer ? { customerStatus: axes.customer } : {}),
    },
  });
  return pending.id;
}

describe("listPendings con filtros de eje", () => {
  it("filtra por el eje de compras", async () => {
    await newPending({ purchase: "POR_PEDIR" });
    await newPending({ purchase: "POR_PEDIR" });
    const solicitado = await newPending({ purchase: "SOLICITADO" });

    const { items } = await listPendings({ axes: { purchase: "SOLICITADO" } });

    expect(items.map((item) => item.id)).toEqual([solicitado]);
  });

  it("filtra por el eje de disponibilidad", async () => {
    await newPending({ availability: "ESPERANDO" });
    const enBodega = await newPending({ availability: "LLEGO_BODEGA" });

    const { items } = await listPendings({ axes: { availability: "LLEGO_BODEGA" } });

    expect(items.map((item) => item.id)).toEqual([enBodega]);
  });

  it("filtra por el eje del cliente", async () => {
    await newPending({ customer: "POR_CONTACTAR" });
    const contactado = await newPending({ customer: "CONTACTADO" });

    const { items } = await listPendings({ axes: { customer: "CONTACTADO" } });

    expect(items.map((item) => item.id)).toEqual([contactado]);
  });

  // Los ejes son independientes, así que combinarlos tiene que ESTRECHAR el
  // resultado. Si se unieran, pedir dos condiciones devolvería más filas que
  // pedir una sola, que es lo contrario de lo que un filtro significa.
  it("combina dos ejes con Y, no con O", async () => {
    await newPending({ purchase: "SOLICITADO", availability: "ESPERANDO" });
    const ambos = await newPending({
      purchase: "SOLICITADO",
      availability: "LLEGO_BODEGA",
    });
    await newPending({ purchase: "POR_PEDIR", availability: "LLEGO_BODEGA" });

    const { items } = await listPendings({
      axes: { purchase: "SOLICITADO", availability: "LLEGO_BODEGA" },
    });

    expect(items.map((item) => item.id)).toEqual([ambos]);
  });

  it("sin ejes devuelve todo lo abierto, como antes", async () => {
    await newPending({ purchase: "POR_PEDIR" });
    await newPending({ purchase: "SOLICITADO" });

    const { items } = await listPendings({});

    expect(items).toHaveLength(2);
  });

  // El recorte por dueño es una regla de acceso, no un filtro más: un eje no
  // puede ensancharlo. Sin esto, filtrar sería una forma de ver lo ajeno.
  it("el recorte por dueño sigue vigente con filtros de eje", async () => {
    const propio = await newPending({ purchase: "SOLICITADO" });
    await newPending({ purchase: "SOLICITADO" }, { owner: otherOwnerId });

    const { items } = await listPendings({
      ownerId,
      axes: { purchase: "SOLICITADO" },
    });

    expect(items.map((item) => item.id)).toEqual([propio]);
  });

  // El cursor apunta a una fila de OTRA vista. Aplicado a esta, Prisma
  // paginaría desde una posición que el filtro no contiene y se saltearía
  // resultados válidos. La regla que ya existe para dueño y scope —cursor que
  // no pertenece, primera página— tiene que valer también para los ejes.
  it("un cursor que el filtro excluye cae a la primera página", async () => {
    const viejo = await newPending(
      { purchase: "SOLICITADO" },
      { createdAt: new Date("2026-08-01T10:00:00Z") },
    );
    const nuevo = await newPending(
      { purchase: "POR_PEDIR" },
      { createdAt: new Date("2026-08-02T10:00:00Z") },
    );

    // Cursor legítimo del listado sin filtrar: apunta al POR_PEDIR, que el
    // filtro de abajo no incluye.
    const sinFiltro = await listPendings({ take: 1 });
    expect(sinFiltro.items.map((item) => item.id)).toEqual([nuevo]);

    const { items } = await listPendings({
      cursor: sinFiltro.nextCursor,
      axes: { purchase: "SOLICITADO" },
    });

    expect(items.map((item) => item.id)).toEqual([viejo]);
  });

  it("pagina de forma estable con un filtro aplicado", async () => {
    const primero = await newPending(
      { purchase: "SOLICITADO" },
      { createdAt: new Date("2026-08-03T10:00:00Z") },
    );
    const segundo = await newPending(
      { purchase: "SOLICITADO" },
      { createdAt: new Date("2026-08-02T10:00:00Z") },
    );
    await newPending({ purchase: "POR_PEDIR" }, { createdAt: new Date("2026-08-01T10:00:00Z") });

    const pagina1 = await listPendings({ take: 1, axes: { purchase: "SOLICITADO" } });
    expect(pagina1.items.map((item) => item.id)).toEqual([primero]);
    expect(pagina1.nextCursor).not.toBeNull();

    const pagina2 = await listPendings({
      cursor: pagina1.nextCursor,
      take: 1,
      axes: { purchase: "SOLICITADO" },
    });
    expect(pagina2.items.map((item) => item.id)).toEqual([segundo]);
    // El POR_PEDIR nunca aparece: el filtro vale en todas las páginas, no solo
    // en la primera.
    expect(pagina2.nextCursor).toBeNull();
  });
});

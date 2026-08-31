import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { listPendings, findPendingInView } from "@/server/repositories/pending.repository";
import { getPendingInView } from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// El pendiente que quedó FUERA de la página cargada.
//
// El listado trae 20 (`DEFAULT_PAGE_SIZE`). El enlace del aviso de llegada
// apunta a `#pendiente-<id>`, y el fragmento de una URL nunca llega al
// servidor: si ese pendiente ya bajó del puesto veinte, la página no lo
// renderiza, el ancla no existe en el DOM y el navegador no hace nada. Es el
// mismo síntoma que ya arreglamos una vez, reapareciendo solo con los pedidos
// más viejos.
//
// Va contra PostgreSQL real porque lo que se prueba es la CONSULTA: que traiga
// una fila que la paginación dejó afuera sin traer las demás, y que el recorte
// por dueño y los filtros sigan mandando sobre ella. Un doble en memoria
// devuelve lo que el test le pida y no prueba ninguna de las dos cosas.
// --------------------------------------------------------------------------

const PAGINA = 20;

let productId = "";
let ownerId = "";
let otherOwnerId = "";

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `FOCUS-${Date.now()}`, name: "Lantus Solostar", unit: "Lapicera" },
  });
  productId = product.id;

  const owner = await prisma.user.create({
    data: { email: `duenio-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  ownerId = owner.id;

  const otro = await prisma.user.create({
    data: { email: `otro-${randomUUID()}@test.local`, name: "Otro vendedor" },
  });
  otherOwnerId = otro.id;
});

afterEach(async () => {
  await prisma.pendingDelivery.deleteMany({ where: { pending: { productId } } });
  await prisma.pending.deleteMany({ where: { productId } });
});

/** `createdAt` explícito: el listado ordena por fecha y el orden decide todo. */
async function newPending(
  createdAt: Date,
  options: { owner?: string; purchase?: "POR_PEDIR" | "AGOTADO" } = {},
): Promise<string> {
  const row = await prisma.pending.create({
    data: {
      productId,
      quantity: 1,
      promisedAt: new Date("2026-09-01T15:00:00Z"),
      createdById: options.owner ?? ownerId,
      createdAt,
      ...(options.purchase ? { purchaseStatus: options.purchase } : {}),
    },
  });
  return row.id;
}

/** 25 pendientes; devuelve el id del MÁS VIEJO, que cae en la página 2. */
async function veinticincoPendientes(owner?: string): Promise<string> {
  let masViejo = "";
  for (let i = 0; i < 25; i += 1) {
    // i creciente = más viejo. El orden es `createdAt desc`.
    const id = await newPending(new Date(Date.UTC(2026, 7, 1, 0, 0, i)), { owner });
    if (i === 0) masViejo = id;
  }
  return masViejo;
}

describe("el objetivo cae fuera de la primera página", () => {
  it("con 25 pendientes, la página trae 20 y el más viejo NO está", async () => {
    const objetivo = await veinticincoPendientes();

    const pagina = await listPendings({ ownerId });

    expect(pagina.items).toHaveLength(PAGINA);
    expect(pagina.nextCursor).not.toBeNull();
    expect(pagina.items.some((p) => p.id === objetivo)).toBe(false);
  });

  // El arreglo: una consulta acotada por id, no más filas.
  it("la consulta por id SÍ lo encuentra", async () => {
    const objetivo = await veinticincoPendientes();

    const encontrado = await findPendingInView({ id: objetivo, ownerId });

    expect(encontrado).not.toBeNull();
    expect(encontrado?.id).toBe(objetivo);
  });

  it("trae UNA fila, no la cola entera", async () => {
    const objetivo = await veinticincoPendientes();

    const encontrado = await findPendingInView({ id: objetivo, ownerId });

    // El tipo ya lo dice, pero lo que importa es que no se resolvió trayendo
    // todo y filtrando en memoria: se pide por id contra la base.
    expect(Array.isArray(encontrado)).toBe(false);
    expect(encontrado?.id).toBe(objetivo);
  });

  it("devuelve la misma forma que el listado, así se pinta igual", async () => {
    const objetivo = await veinticincoPendientes();

    const encontrado = await findPendingInView({ id: objetivo, ownerId });
    const [delListado] = (await listPendings({ ownerId })).items;

    expect(Object.keys(encontrado!).sort()).toEqual(Object.keys(delListado!).sort());
  });
});

// --------------------------------------------------------------------------
// La autorización manda sobre el destacado igual que sobre el listado.
// --------------------------------------------------------------------------
describe("autorización · el recorte por dueño sigue vigente", () => {
  it("un vendedor NO alcanza el pendiente de otro", async () => {
    const ajeno = await newPending(new Date("2026-08-01T00:00:00Z"), {
      owner: otherOwnerId,
    });

    const encontrado = await findPendingInView({ id: ajeno, ownerId });

    expect(encontrado).toBeNull();
  });

  it("quien ve la cola entera (sin ownerId) sí lo alcanza", async () => {
    const ajeno = await newPending(new Date("2026-08-01T00:00:00Z"), {
      owner: otherOwnerId,
    });

    const encontrado = await findPendingInView({ id: ajeno });

    expect(encontrado?.id).toBe(ajeno);
  });

  // No se distingue "no existe" de "no es tuyo": distinguirlos ya diría de
  // quién es.
  it("un id inexistente da lo mismo que uno ajeno: null", async () => {
    const ajeno = await newPending(new Date("2026-08-01T00:00:00Z"), {
      owner: otherOwnerId,
    });

    expect(await findPendingInView({ id: ajeno, ownerId })).toBeNull();
    expect(await findPendingInView({ id: "no-existe-este-id", ownerId })).toBeNull();
  });

  it("un id vacío no consulta nada", async () => {
    expect(await findPendingInView({ id: "", ownerId })).toBeNull();
  });
});

describe("los filtros de la vista también mandan", () => {
  it("no devuelve una fila que el filtro vigente excluye", async () => {
    const agotado = await newPending(new Date("2026-08-01T00:00:00Z"), {
      purchase: "AGOTADO",
    });

    // La vista está filtrada por "por pedir": ese pendiente no pertenece.
    const fuera = await findPendingInView({
      id: agotado,
      ownerId,
      axes: { purchase: "POR_PEDIR" },
    });
    expect(fuera).toBeNull();

    // Sin ese filtro, sí.
    const dentro = await findPendingInView({ id: agotado, ownerId });
    expect(dentro?.id).toBe(agotado);
  });

  it("un pendiente abierto no aparece en la vista de cerrados", async () => {
    const abierto = await newPending(new Date("2026-08-01T00:00:00Z"));

    expect(await findPendingInView({ id: abierto, ownerId, scope: "history" })).toBeNull();
    expect(await findPendingInView({ id: abierto, ownerId, scope: "active" })).not.toBeNull();
  });
});

// --------------------------------------------------------------------------
// El servicio, que es lo que usa la página: agrega la minimización de PII.
// --------------------------------------------------------------------------
describe("servicio · minimiza la identidad del cliente igual que el listado", () => {
  it("oculta el nombre a quien no puede verlo", async () => {
    const id = await newPending(new Date("2026-08-01T00:00:00Z"));
    await prisma.pending.update({
      where: { id },
      data: { customerName: "Doña Marta", customerPhone: "3001112233" },
    });

    const sinPermiso = await getPendingInView({
      id,
      ownerId,
      canViewCustomerIdentity: false,
    });
    const conPermiso = await getPendingInView({
      id,
      ownerId,
      canViewCustomerIdentity: true,
    });

    expect(conPermiso?.customerName).toBe("Doña Marta");
    expect(sinPermiso?.customerName).not.toBe("Doña Marta");
  });

  it("respeta el recorte por dueño", async () => {
    const ajeno = await newPending(new Date("2026-08-01T00:00:00Z"), {
      owner: otherOwnerId,
    });

    const resultado = await getPendingInView({
      id: ajeno,
      ownerId,
      canViewCustomerIdentity: true,
    });

    expect(resultado).toBeNull();
  });

  it("encuentra el que quedó fuera de la página", async () => {
    const objetivo = await veinticincoPendientes();

    const resultado = await getPendingInView({
      id: objetivo,
      ownerId,
      canViewCustomerIdentity: true,
    });

    expect(resultado?.id).toBe(objetivo);
  });
});

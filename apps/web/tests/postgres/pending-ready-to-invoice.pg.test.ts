import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { invoiceableQuantity } from "@/features/pendientes/fulfillment-notice";
import { prisma } from "@/lib/db/prisma";
import type {
  PendingCustomerStatus,
  PendingPurchaseStatus,
  PendingStatus,
} from "@/lib/generated/prisma/client";
import {
  countReadyToInvoicePendings,
  listPendings,
  type PendingListItem,
} from "@/server/repositories/pending.repository";
import { getReadyToInvoiceCount } from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// U4 — "Listos para facturar": UNA sola regla en dos idiomas.
//
// En TypeScript es `invoiceableQuantity` (el aviso amarillo, el botón, el color
// de la tarjeta). En la base es `readyToInvoiceWhere` (el filtro
// `facturar=listos` y el contador del chip). Si divergen, el chip dice 4 y la
// lista muestra 6, o la fila está amarilla y el filtro no la trae.
//
// Va contra PostgreSQL real porque lo que se prueba es la CONSULTA: dos
// comparaciones entre columnas de la misma fila y su combinación con la ventana
// de entrega. Un doble en memoria devuelve lo que se le pida.
//
// Las filas respetan `pendings_quantities_check`:
//   delivered ≤ invoiced ≤ inventoryReady ≤ quantity.
// --------------------------------------------------------------------------

const PAST = new Date("2020-01-01T15:00:00Z");
const FUTURE = new Date("2099-01-01T15:00:00Z");
const TAKE = 100;

let productId = "";
let ownerId = "";
let otherOwnerId = "";

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `READY-${Date.now()}`, name: "Ensure Advance", unit: "Lata" },
  });
  productId = product.id;

  const owner = await prisma.user.create({
    data: { email: `listos-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  ownerId = owner.id;

  const other = await prisma.user.create({
    data: { email: `listos-otro-${randomUUID()}@test.local`, name: "Otro vendedor" },
  });
  otherOwnerId = other.id;
});

afterEach(async () => {
  await prisma.pendingDelivery.deleteMany({ where: { pending: { productId } } });
  await prisma.pending.deleteMany({ where: { productId } });
});

type Seed = {
  quantity?: number;
  ready?: number;
  invoiced?: number;
  delivered?: number;
  status?: PendingStatus;
  customerStatus?: PendingCustomerStatus;
  purchaseStatus?: PendingPurchaseStatus;
  promisedAt?: Date;
  owner?: string;
};

async function seed(name: string, options: Seed = {}): Promise<[string, string]> {
  const row = await prisma.pending.create({
    data: {
      productId,
      quantity: options.quantity ?? 10,
      inventoryReadyQuantity: options.ready ?? 0,
      invoicedQuantity: options.invoiced ?? 0,
      deliveredQuantity: options.delivered ?? 0,
      status: options.status ?? "PENDIENTE",
      customerStatus: options.customerStatus ?? "POR_CONTACTAR",
      purchaseStatus: options.purchaseStatus ?? "POR_PEDIR",
      promisedAt: options.promisedAt ?? FUTURE,
      createdById: options.owner ?? ownerId,
      note: name,
    },
  });
  return [name, row.id];
}

/** Los casos de la regla, todos del mismo dueño. */
async function seedRuleCases(): Promise<Map<string, string>> {
  const rows = await Promise.all([
    // Listos (X > 0)
    seed("completo", { ready: 10 }),
    seed("parcial", { ready: 5 }),
    seed("facturado-a-medias", { ready: 10, invoiced: 4, customerStatus: "FACTURADO" }),
    seed("agotado-con-carga", { ready: 3, purchaseStatus: "AGOTADO" }),
    // No listos (X = 0)
    seed("sin-carga"),
    seed("todo-facturado", { ready: 5, invoiced: 5, customerStatus: "FACTURADO" }),
    seed("parcial-facturado-y-entregado", {
      ready: 7,
      invoiced: 7,
      delivered: 4,
      status: "PARCIAL",
      customerStatus: "FACTURADO",
    }),
    seed("cliente-cancelado", { ready: 10, customerStatus: "CANCELADO" }),
    seed("cliente-entregado", {
      ready: 10,
      invoiced: 5,
      delivered: 5,
      customerStatus: "ENTREGADO",
    }),
    seed("entregado", {
      ready: 10,
      invoiced: 5,
      delivered: 5,
      status: "ENTREGADO",
      customerStatus: "FACTURADO",
    }),
    seed("cancelado", { ready: 6, status: "CANCELADO" }),
    seed("cierre-parcial", {
      ready: 6,
      invoiced: 3,
      delivered: 3,
      status: "CLOSED_PARTIAL",
      customerStatus: "FACTURADO",
    }),
  ]);
  return new Map(rows);
}

const EXPECTED_READY = ["completo", "parcial", "facturado-a-medias", "agotado-con-carga"];

function names(items: PendingListItem[]): string[] {
  return items.map((item) => item.note ?? "").sort();
}

function ids(items: PendingListItem[]): string[] {
  return items.map((item) => item.id).sort();
}

describe("la lista filtrada es exactamente la regla de TypeScript", () => {
  it("vista activa: trae lo que invoiceableQuantity dice listo, y nada más", async () => {
    await seedRuleCases();

    const all = await listPendings({ ownerId, take: TAKE });
    const filtered = await listPendings({ ownerId, take: TAKE, axes: { invoice: "listos" } });

    const byRule = all.items.filter((item) => invoiceableQuantity(item) > 0);
    expect(ids(filtered.items)).toEqual(ids(byRule));
    expect(names(filtered.items)).toEqual([...EXPECTED_READY].sort());
  });

  it("historial: ningún terminal está listo, ni para la regla ni para la consulta", async () => {
    await seedRuleCases();

    const history = await listPendings({ ownerId, take: TAKE, scope: "history" });
    const filtered = await listPendings({
      ownerId,
      take: TAKE,
      scope: "history",
      axes: { invoice: "listos" },
    });

    expect(history.items.length).toBeGreaterThan(0);
    expect(history.items.filter((item) => invoiceableQuantity(item) > 0)).toEqual([]);
    expect(filtered.items).toEqual([]);
  });
});

describe("el contador es el tamaño de la lista", () => {
  it("cuenta pendientes, no unidades, y coincide con la lista filtrada", async () => {
    await seedRuleCases();

    const filtered = await listPendings({ ownerId, take: TAKE, axes: { invoice: "listos" } });

    expect(await countReadyToInvoicePendings(ownerId)).toBe(filtered.items.length);
    expect(await getReadyToInvoiceCount({ ownerId })).toBe(EXPECTED_READY.length);
  });

  it("sin dueño, el total también coincide con la lista de la cola entera", async () => {
    await seedRuleCases();
    await seed("ajeno-listo", { ready: 10, owner: otherOwnerId });

    const filtered = await listPendings({ take: TAKE, axes: { invoice: "listos" } });

    expect(await getReadyToInvoiceCount({})).toBe(filtered.items.length);
  });

  // Independiente de los otros filtros: el chip es el total del alcance.
  it("no depende de otros filtros de la vista", async () => {
    await seedRuleCases();

    const withPurchase = await listPendings({
      ownerId,
      take: TAKE,
      axes: { invoice: "listos", purchase: "AGOTADO" },
    });

    expect(names(withPurchase.items)).toEqual(["agotado-con-carga"]);
    expect(await getReadyToInvoiceCount({ ownerId })).toBe(EXPECTED_READY.length);
  });
});

describe("alcance propio: el vendedor no cuenta ni ve los listos de otro", () => {
  it("excluye los pendientes de otro vendedor de la lista y del contador", async () => {
    await seedRuleCases();
    const [, foreignId] = await seed("ajeno-listo", { ready: 10, owner: otherOwnerId });

    const own = await listPendings({ ownerId, take: TAKE, axes: { invoice: "listos" } });
    const everyone = await listPendings({ take: TAKE, axes: { invoice: "listos" } });

    expect(own.items.some((item) => item.id === foreignId)).toBe(false);
    expect(everyone.items.some((item) => item.id === foreignId)).toBe(true);
    expect(await getReadyToInvoiceCount({ ownerId })).toBe(EXPECTED_READY.length);
    expect(await getReadyToInvoiceCount({ ownerId: otherOwnerId })).toBe(1);
  });
});

// --------------------------------------------------------------------------
// Regresión del AND: la entrega y "listos" son derivados que viven en `AND`. Si
// cada uno derramara su propio `{ AND: [...] }`, el segundo pisaría al primero y
// el filtro combinado traería los listos de cualquier fecha.
// --------------------------------------------------------------------------
describe("facturar=listos combinado con la ventana de entrega", () => {
  it("se cumplen LAS DOS condiciones", async () => {
    await Promise.all([
      seed("listo-atrasado", { ready: 10, promisedAt: PAST }),
      seed("listo-a-tiempo", { ready: 10, promisedAt: FUTURE }),
      seed("atrasado-sin-carga", { promisedAt: PAST }),
    ]);

    const both = await listPendings({
      ownerId,
      take: TAKE,
      axes: { invoice: "listos", deadline: "atrasadas" },
    });
    const onlyDeadline = await listPendings({
      ownerId,
      take: TAKE,
      axes: { deadline: "atrasadas" },
    });
    const onlyReady = await listPendings({ ownerId, take: TAKE, axes: { invoice: "listos" } });

    expect(names(both.items)).toEqual(["listo-atrasado"]);
    expect(names(onlyDeadline.items)).toEqual(["atrasado-sin-carga", "listo-atrasado"]);
    expect(names(onlyReady.items)).toEqual(["listo-a-tiempo", "listo-atrasado"]);
  });
});

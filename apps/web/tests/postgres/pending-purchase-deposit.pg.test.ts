import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import type { PendingStatus } from "@/lib/generated/prisma/client";
import {
  findPendingInView,
  listPendings,
} from "@/server/repositories/pending.repository";
import {
  getPendingInView,
  getPendings,
  setPendingPurchaseDeposit,
} from "@/server/services/pending.service";

// --------------------------------------------------------------------------
// Depósito de compra, contra PostgreSQL real.
//
// Lo que un doble no puede probar: que la columna existe y persiste, que el
// UPDATE protegido por estado no toca un pendiente cerrado, que la auditoría
// queda en la misma transacción y que, sin el permiso, la fila que devuelve la
// base ni siquiera trae la propiedad.
// --------------------------------------------------------------------------

const RUN = randomUUID().slice(0, 6);
const FUTURE = new Date("2099-01-01T15:00:00Z");

let productId = "";
let ownerId = "";
let warehouseId = "";

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `DEPOSITO-${Date.now()}`, name: `Jarabe ${RUN}`, unit: "frasco" },
  });
  productId = product.id;

  const owner = await prisma.user.create({
    data: { email: `deposito-vendedor-${randomUUID()}@test.local`, name: "Vendedora" },
  });
  ownerId = owner.id;

  const warehouse = await prisma.user.create({
    data: { email: `deposito-bodega-${randomUUID()}@test.local`, name: "Bodega" },
  });
  warehouseId = warehouse.id;
});

afterEach(async () => {
  const pendings = await prisma.pending.findMany({ where: { productId }, select: { id: true } });
  const ids = pendings.map((row) => row.id);
  await prisma.auditLog.deleteMany({ where: { entity: "Pending", entityId: { in: ids } } });
  await prisma.pending.deleteMany({ where: { productId } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, warehouseId] } } });
});

async function seed(status: PendingStatus = "PENDIENTE"): Promise<string> {
  const pending = await prisma.pending.create({
    data: {
      productId,
      quantity: 2,
      status,
      promisedAt: FUTURE,
      createdById: ownerId,
    },
  });
  return pending.id;
}

function stored(id: string) {
  return prisma.pending.findUniqueOrThrow({ where: { id }, select: { purchaseDeposit: true } });
}

function depositAudits(id: string) {
  return prisma.auditLog.findMany({
    where: { action: AUDIT_ACTIONS.PENDING_PURCHASE_DEPOSIT_UPDATED, entityId: id },
    orderBy: { createdAt: "asc" },
  });
}

describe("setPendingPurchaseDeposit · persistencia y auditoría", () => {
  it("lo persiste y lo limpia, con un asiento de auditoría por cambio", async () => {
    const id = await seed();

    // Bodega lo escribe sobre un pendiente que NO cargó.
    const written = await setPendingPurchaseDeposit({ id, deposit: "N3", actorId: warehouseId });
    expect(written).toEqual({ rejection: null, changed: true });
    expect((await stored(id)).purchaseDeposit).toBe("N3");

    const cleared = await setPendingPurchaseDeposit({ id, deposit: null, actorId: warehouseId });
    expect(cleared).toEqual({ rejection: null, changed: true });
    expect((await stored(id)).purchaseDeposit).toBeNull();

    const audits = await depositAudits(id);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toEqual(
      expect.objectContaining({
        entity: "Pending",
        userId: warehouseId,
        before: { purchaseDeposit: null },
        after: { purchaseDeposit: "N3" },
      }),
    );
    expect(audits[1]).toEqual(
      expect.objectContaining({
        before: { purchaseDeposit: "N3" },
        after: { purchaseDeposit: null },
      }),
    );
  });

  it("guardar el mismo valor no escribe otro asiento", async () => {
    const id = await seed();

    await setPendingPurchaseDeposit({ id, deposit: "N3", actorId: warehouseId });
    const again = await setPendingPurchaseDeposit({ id, deposit: "N3", actorId: warehouseId });

    expect(again).toEqual({ rejection: null, changed: false });
    expect(await depositAudits(id)).toHaveLength(1);
  });

  it.each(["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"] as const)(
    "un pendiente %s no se edita ni se audita",
    async (status) => {
      const id = await seed(status);

      const result = await setPendingPurchaseDeposit({ id, deposit: "N3", actorId: warehouseId });

      expect(result).toEqual({ rejection: "CLOSED", changed: false });
      expect((await stored(id)).purchaseDeposit).toBeNull();
      expect(await depositAudits(id)).toHaveLength(0);
    },
  );
});

describe("lectura · minimización del depósito", () => {
  it("sin el permiso la fila no trae la propiedad; con el permiso sí", async () => {
    const id = await seed();
    await prisma.pending.update({ where: { id }, data: { purchaseDeposit: "N3" } });

    const deniedList = await listPendings({ ownerId });
    const deniedRow = deniedList.items.find((item) => item.id === id);
    expect(deniedRow).toBeDefined();
    expect(deniedRow).not.toHaveProperty("purchaseDeposit");

    const deniedService = await getPendings({ canViewCustomerIdentity: false, ownerId });
    const deniedServiceRow = deniedService.items.find((item) => item.id === id);
    expect(deniedServiceRow).toBeDefined();
    expect(deniedServiceRow).not.toHaveProperty("purchaseDeposit");

    const deniedFocus = await getPendingInView({ id, canViewCustomerIdentity: false, ownerId });
    expect(deniedFocus).not.toBeNull();
    expect(deniedFocus).not.toHaveProperty("purchaseDeposit");

    const allowed = await getPendings({
      canViewCustomerIdentity: false,
      canViewPurchaseDeposit: true,
      ownerId,
    });
    expect(allowed.items.find((item) => item.id === id)?.purchaseDeposit).toBe("N3");

    const allowedFocus = await findPendingInView({ id, ownerId, canViewPurchaseDeposit: true });
    expect(allowedFocus?.purchaseDeposit).toBe("N3");
  });
});

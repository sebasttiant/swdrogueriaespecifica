import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import {
  IdempotencyPayloadConflictError,
  ProductIdentityExceptionNotApplicableError,
  ProductIdentityRequiredError,
  registerInventoryEntry,
} from "@/server/services/inventory-entry.service";

// --------------------------------------------------------------------------
// Sin SKU no entra mercadería al inventario.
//
// El SKU es lo único que ata un producto de la droguería con el mismo producto
// en Orion. Cargar stock contra un producto sin identidad crea inventario que
// después nadie puede cuadrar: existe acá y no existe allá, y la diferencia
// aparece recién cuando alguien hace el conteo.
//
// El vendedor SÍ puede aplazar el SKU al tomar el pedido —tiene al cliente
// delante y no puede frenarse por eso—, pero ese aplazamiento tiene que
// resolverse antes de que la mercadería toque el inventario. Bodega es quien
// tiene la caja en la mano, con el código impreso encima: es el momento y la
// persona correctos para completarlo.
// --------------------------------------------------------------------------

let conSku = "";
let sinSku = "";
const RUN = randomUUID().slice(0, 6);

beforeAll(async () => {
  const identificado = await prisma.product.create({
    data: {
      code: `SKU-OK-${Date.now()}`,
      name: `Amoxicilina ${RUN}`,
      unit: "caja",
      orionCode: `ORN-${RUN}`,
    },
  });
  conSku = identificado.id;

  const sinIdentidad = await prisma.product.create({
    data: {
      code: `SKU-NO-${Date.now()}`,
      name: `Ibuprofeno ${RUN}`,
      unit: "caja",
      // Sin `orionCode`: el producto nació de la excepción del vendedor.
    },
  });
  sinSku = sinIdentidad.id;
});

afterEach(async () => {
  const ids = [conSku, sinSku];
  await prisma.auditLog.deleteMany({
    where: { action: AUDIT_ACTIONS.ENTRY_IDENTITY_DEFERRED },
  });
  await prisma.inventoryEntry.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productBatch.deleteMany({ where: { productId: { in: ids } } });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: { in: [conSku, sinSku] } } });
});

function entrada(productId: string, extra: Record<string, unknown> = {}) {
  return {
    productId,
    quantity: 5,
    batchCode: `L-${randomUUID().slice(0, 6)}`,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
    createdById: null,
    ...extra,
  };
}

describe("registerInventoryEntry · recepción controlada sin SKU", () => {
  it("sigue rechazando una entrada sin SKU cuando nadie confirmó la excepción", async () => {
    await expect(
      registerInventoryEntry(entrada(sinSku)),
    ).rejects.toBeInstanceOf(ProductIdentityRequiredError);
  });

  // El rechazo nombra el producto: quien recibe la caja tiene que saber cuál
  // completar, y un id interno no le sirve para buscarlo en la pantalla.
  it("el rechazo dice QUÉ producto le falta el SKU", async () => {
    await expect(registerInventoryEntry(entrada(sinSku))).rejects.toMatchObject({
      productId: sinSku,
      productName: `Ibuprofeno ${RUN}`,
    });
  });

  // Lo importante no es que falle: es que no deje nada a medias. Un lote creado
  // por una entrada rechazada es stock fantasma.
  it("no crea lote ni movimiento", async () => {
    await registerInventoryEntry(entrada(sinSku)).catch(() => {});

    expect(await prisma.productBatch.count({ where: { productId: sinSku } })).toBe(0);
    expect(await prisma.inventoryEntry.count({ where: { productId: sinSku } })).toBe(0);
  });

  it("acepta una entrada sin SKU solamente con confirmación y motivo", async () => {
    const result = await registerInventoryEntry(
      entrada(sinSku, {
        identityException: {
          acknowledged: true,
          reason: "NEW_PRODUCT",
          note: "Orión todavía no lo tiene creado",
        },
      }),
    );

    expect(result.entry.id).toBeTruthy();
    expect(await prisma.productBatch.count({ where: { productId: sinSku } })).toBe(1);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: sinSku } })).toMatchObject({
      orionCode: null,
    });
    expect(await prisma.inventoryEntry.findUniqueOrThrow({ where: { id: result.entry.id } }))
      .toMatchObject({
        identityExceptionReason: "NEW_PRODUCT",
        identityExceptionNote: "Orión todavía no lo tiene creado",
      });
  });

  it("audita la excepción dentro de la misma operación sin exponer la nota", async () => {
    const result = await registerInventoryEntry(
      entrada(sinSku, {
        identityException: {
          acknowledged: true,
          reason: "ORION_UNAVAILABLE",
          note: "Texto operativo que no debe copiarse a auditoría",
        },
      }),
    );

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        action: AUDIT_ACTIONS.ENTRY_IDENTITY_DEFERRED,
        entityId: result.entry.id,
      },
    });
    expect(audit.after).toMatchObject({
      productId: sinSku,
      reason: "ORION_UNAVAILABLE",
      acknowledged: true,
    });
    expect(JSON.stringify(audit.after)).not.toContain("Texto operativo");
  });

  it("rechaza una excepción vieja si el producto ya tiene SKU", async () => {
    await expect(
      registerInventoryEntry(
        entrada(conSku, {
          identityException: { acknowledged: true, reason: "CODE_NOT_FOUND" },
        }),
      ),
    ).rejects.toBeInstanceOf(ProductIdentityExceptionNotApplicableError);

    expect(await prisma.inventoryEntry.count({ where: { productId: conSku } })).toBe(0);
  });

  it("revierte lote y entrada si no puede auditar la excepción", async () => {
    await expect(
      registerInventoryEntry(
        entrada(sinSku, {
          identityException: { acknowledged: true, reason: "OTHER" },
        }),
        {
          writeAudit: async () => {
            throw new Error("audit unavailable");
          },
        },
      ),
    ).rejects.toThrow("audit unavailable");

    expect(await prisma.productBatch.count({ where: { productId: sinSku } })).toBe(0);
    expect(await prisma.inventoryEntry.count({ where: { productId: sinSku } })).toBe(0);
  });

  it("reintenta exactamente una vez y rechaza cambiar el motivo", async () => {
    const idempotencyKey = randomUUID();
    const payload = entrada(sinSku, {
      idempotencyKey,
      identityException: {
        acknowledged: true,
        reason: "NEW_PRODUCT",
        note: "Alta pendiente en Orión",
      },
    });

    const first = await registerInventoryEntry(payload);
    const replay = await registerInventoryEntry(payload);

    expect(replay.idempotent).toBe(true);
    expect(replay.entry.id).toBe(first.entry.id);
    expect(await prisma.inventoryEntry.count({ where: { productId: sinSku } })).toBe(1);
    expect(await prisma.auditLog.count({
      where: { action: AUDIT_ACTIONS.ENTRY_IDENTITY_DEFERRED },
    })).toBe(1);

    await expect(
      registerInventoryEntry({
        ...payload,
        identityException: {
          acknowledged: true,
          reason: "ORION_UNAVAILABLE",
          note: "Alta pendiente en Orión",
        },
      }),
    ).rejects.toBeInstanceOf(IdempotencyPayloadConflictError);
  });

  it("acepta la entrada normal cuando el producto tiene SKU", async () => {
    const result = await registerInventoryEntry(entrada(conSku));

    expect(result.entry.id).toBeTruthy();
    expect(await prisma.productBatch.count({ where: { productId: conSku } })).toBe(1);
  });

  it("después de vincular el SKU ya no necesita excepción", async () => {
    await prisma.product.update({
      where: { id: sinSku },
      data: { orionCode: `ORN-TARDE-${RUN}` },
    });

    const result = await registerInventoryEntry(entrada(sinSku));
    expect(result.entry.id).toBeTruthy();
    expect(
      await prisma.product.count({ where: { name: `Ibuprofeno ${RUN}` } }),
    ).toBe(1);
  });
});

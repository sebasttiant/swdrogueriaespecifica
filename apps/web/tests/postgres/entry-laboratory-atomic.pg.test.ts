import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  IdempotencyPayloadConflictError,
  registerInventoryEntry,
} from "@/server/services/inventory-entry.service";

// --------------------------------------------------------------------------
// El laboratorio de una entrada vive y muere con la entrada.
//
// La captura resolvía el laboratorio en la Server Action, ANTES de abrir la
// transacción de inventario y antes del preflight de idempotencia. Con eso, una
// entrada que se rechaza después —payload de idempotencia distinto, producto
// inexistente, conflicto de evidencia— dejaba creado un laboratorio que nadie
// pidió: bodega tipeaba mal, la entrada se rechazaba, y el catálogo se quedaba
// con la basura.
//
// Se prueba contra PostgreSQL real porque lo que se afirma es que el rollback
// alcanza al laboratorio, y eso solo lo decide la transacción.
// --------------------------------------------------------------------------

let productId = "";
const RUN = randomUUID().slice(0, 6);

beforeAll(async () => {
  const product = await prisma.product.create({
    data: { code: `ATO-${Date.now()}`, name: "Losartán 50mg", unit: "caja" },
  });
  productId = product.id;
});

afterEach(async () => {
  await prisma.inventoryEntry.deleteMany({ where: { productId } });
  await prisma.productBatch.deleteMany({ where: { productId } });
  await prisma.laboratory.deleteMany({ where: { name: { contains: RUN } } });
});

function entrada(overrides: Record<string, unknown> = {}) {
  return {
    productId,
    quantity: 5,
    batchCode: `L-${RUN}`,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
    createdById: null,
    ...overrides,
  };
}

async function existeLaboratorio(name: string): Promise<boolean> {
  const n = await prisma.laboratory.count({ where: { name } });
  return n > 0;
}

describe("registerInventoryEntry · el laboratorio no sobrevive a una entrada rechazada", () => {
  it("un conflicto de idempotencia NO deja el laboratorio creado", async () => {
    const key = `idem-${RUN}`;
    await registerInventoryEntry(
      entrada({ idempotencyKey: key, receivedLaboratoryName: `Lab Uno ${RUN}` }),
    );

    // Misma clave, OTRA carga: el servicio tiene que rechazarla. El laboratorio
    // nuevo que trae esta segunda entrada no puede quedar.
    const nombreNuevo = `Lab Dos ${RUN}`;
    await expect(
      registerInventoryEntry(
        entrada({
          idempotencyKey: key,
          quantity: 99,
          receivedLaboratoryName: nombreNuevo,
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyPayloadConflictError);

    expect(await existeLaboratorio(nombreNuevo)).toBe(false);
  });

  it("una entrada sobre un producto inexistente NO deja el laboratorio creado", async () => {
    const nombre = `Lab Huerfano ${RUN}`;

    await expect(
      registerInventoryEntry(
        entrada({ productId: "producto-que-no-existe", receivedLaboratoryName: nombre }),
      ),
    ).rejects.toThrow();

    expect(await existeLaboratorio(nombre)).toBe(false);
  });

  it("la entrada que SÍ se acepta deja el laboratorio y lo vincula al lote", async () => {
    const nombre = `Lab Bueno ${RUN}`;

    const result = await registerInventoryEntry(
      entrada({ receivedLaboratoryName: nombre }),
    );

    expect(result.idempotent).toBe(false);
    expect(await existeLaboratorio(nombre)).toBe(true);

    const lote = await prisma.productBatch.findFirstOrThrow({
      where: { productId, batchCode: `L-${RUN}` },
      include: { receivedLaboratory: true },
    });
    expect(lote.receivedLaboratory?.name).toBe(nombre);
    expect(lote.laboratoryEvidence).toBe("OBSERVED");
  });
});

describe("registerInventoryEntry · idempotencia con laboratorio por nombre", () => {
  it("el reintento exacto devuelve la misma entrada y NO duplica el laboratorio", async () => {
    const key = `rep-${RUN}`;
    const nombre = `Lab Repetido ${RUN}`;

    const primera = await registerInventoryEntry(
      entrada({ idempotencyKey: key, receivedLaboratoryName: nombre }),
    );
    const segunda = await registerInventoryEntry(
      entrada({ idempotencyKey: key, receivedLaboratoryName: nombre }),
    );

    expect(primera.idempotent).toBe(false);
    expect(segunda.idempotent).toBe(true);
    expect(segunda.entry.id).toBe(primera.entry.id);
    expect(await prisma.laboratory.count({ where: { name: nombre } })).toBe(1);
  });

  // El nombre forma parte de la carga: dos entradas con la MISMA clave y
  // laboratorios distintos no son la misma entrada, y tratarlas como iguales
  // dejaría el lote con una evidencia que nadie mandó.
  it("el mismo idempotencyKey con OTRO laboratorio es un conflicto, no un reintento", async () => {
    const key = `dist-${RUN}`;

    await registerInventoryEntry(
      entrada({ idempotencyKey: key, receivedLaboratoryName: `Lab A ${RUN}` }),
    );

    await expect(
      registerInventoryEntry(
        entrada({ idempotencyKey: key, receivedLaboratoryName: `Lab B ${RUN}` }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyPayloadConflictError);
  });

  it("dos escrituras distintas del mismo nombre resuelven al MISMO laboratorio", async () => {
    const nombre = `Lab Canonico ${RUN}`;

    await registerInventoryEntry(
      entrada({ idempotencyKey: `c1-${RUN}`, receivedLaboratoryName: nombre }),
    );
    await registerInventoryEntry(
      entrada({
        idempotencyKey: `c2-${RUN}`,
        batchCode: `L2-${RUN}`,
        receivedLaboratoryName: nombre.toUpperCase(),
      }),
    );

    // La identidad la decide la base: mayúsculas distintas, mismo laboratorio.
    const filas = await prisma.laboratory.findMany({
      where: { name: { contains: RUN } },
    });
    expect(filas).toHaveLength(1);
  });
});

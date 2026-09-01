import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  ProductNotFoundError,
  ProductVersionConflictError,
  registerInventoryEntry,
} from "@/server/services/inventory-entry.service";
import { editProduct } from "@/server/services/product.service";

// --------------------------------------------------------------------------
// Una entrada se registra contra la FOTOGRAFIA del producto que la persona vio.
//
// Bodega abre el formulario, lee el SKU y la presentacion en pantalla, y busca
// esa caja en el deposito. Mientras tanto, alguien en Productos corrige el SKU
// o cambia la presentacion. Si la entrada se registra igual, queda cargada
// contra un producto que ya no es el que se leyo: el stock existe, y nadie
// puede reconstruir contra que identidad entro.
//
// El control NO es `updatedAt`. Una marca de tiempo dice CUANDO paso algo, no
// en que ORDEN, y dos escrituras rapidas pueden compartir milisegundo. Se
// comparan los DOS contadores enteros que ya protegen al producto:
//
//   identityVersion -> el vinculo con el codigo de Orion (el SKU).
//   catalogVersion  -> nombre, presentacion, minimos, laboratorio, activo.
//
// Y se comparan bajo `SELECT ... FOR UPDATE` DENTRO de la misma transaccion
// que escribe el lote: leer primero y escribir despues deja una ventana en la
// que el producto cambia entre la comprobacion y la escritura.
// --------------------------------------------------------------------------

const RUN = randomUUID().slice(0, 8);
const creados: string[] = [];

type Fotografia = {
  id: string;
  identityVersion: number;
  catalogVersion: number;
};

async function nuevoProducto(sufijo: string): Promise<Fotografia> {
  const producto = await prisma.product.create({
    data: {
      code: `S2-${sufijo}-${randomUUID().slice(0, 8)}`,
      name: `Amoxicilina ${sufijo} ${RUN}`,
      unit: "frasco",
      orionCode: `ORN-${sufijo}-${randomUUID().slice(0, 8)}`,
    },
  });
  creados.push(producto.id);
  return {
    id: producto.id,
    identityVersion: producto.identityVersion,
    catalogVersion: producto.catalogVersion,
  };
}

function entrada(foto: Fotografia, extra: Record<string, unknown> = {}) {
  return {
    productId: foto.id,
    quantity: 5,
    batchCode: `L-${randomUUID().slice(0, 8)}`,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
    createdById: null,
    expectedIdentityVersion: foto.identityVersion,
    expectedCatalogVersion: foto.catalogVersion,
    ...extra,
  };
}

/** Mueve `catalogVersion` por el camino real, no escribiendo la columna. */
async function editarCatalogo(id: string, version: number, unit: string) {
  const actual = await prisma.product.findUniqueOrThrow({ where: { id } });
  return editProduct(id, {
    code: actual.code,
    name: actual.name,
    unit,
    minStock: actual.minStock,
    reorderQty: actual.reorderQty,
    laboratoryId: actual.laboratoryId,
    active: actual.active,
    expectedVersion: version,
    actorId: "test",
  });
}

async function limpiar(ids: string[]) {
  await prisma.inventoryAllocation.deleteMany({
    where: { inventoryEntry: { productId: { in: ids } } },
  });
  await prisma.inventoryEntry.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productBatch.deleteMany({ where: { productId: { in: ids } } });
}

afterEach(async () => {
  await limpiar(creados);
});

afterAll(async () => {
  await limpiar(creados);
  await prisma.product.deleteMany({ where: { id: { in: creados } } });
});

describe("registerInventoryEntry · la entrada declara la fotografia que vio", () => {
  let foto: Fotografia;
  beforeEach(async () => {
    foto = await nuevoProducto("ok");
  });

  it("registra la entrada cuando las DOS versiones siguen vigentes", async () => {
    const result = await registerInventoryEntry(entrada(foto));

    expect(result.entry.id).toBeTruthy();
    expect(await prisma.productBatch.count({ where: { productId: foto.id } })).toBe(1);
  });

  it("rechaza cuando el producto no existe", async () => {
    await expect(
      registerInventoryEntry(entrada({ ...foto, id: "producto-que-no-existe" })),
    ).rejects.toBeInstanceOf(ProductNotFoundError);
  });
});

describe("registerInventoryEntry · alguien cambio el catalogo en el medio", () => {
  let foto: Fotografia;
  beforeEach(async () => {
    foto = await nuevoProducto("cat");
  });

  it("rechaza la entrada y dice que fue el CATALOGO", async () => {
    await editarCatalogo(foto.id, foto.catalogVersion, "caja");

    const rechazo = await registerInventoryEntry(entrada(foto)).catch((e) => e);

    expect(rechazo).toBeInstanceOf(ProductVersionConflictError);
    expect(rechazo.kind).toBe("catalog");
  });

  // El rechazo nombra lo que el producto dice AHORA. Quien tiene la caja en la
  // mano puede cotejarlo contra lo impreso sin salir de la pantalla.
  it("el rechazo trae el SKU y la presentacion autoritativos", async () => {
    await editarCatalogo(foto.id, foto.catalogVersion, "caja");
    const actual = await prisma.product.findUniqueOrThrow({ where: { id: foto.id } });

    const rechazo = await registerInventoryEntry(entrada(foto)).catch((e) => e);

    expect(rechazo.product).toMatchObject({
      orionCode: actual.orionCode,
      unit: "caja",
      catalogVersion: actual.catalogVersion,
    });
  });

  // Lo que importa no es que falle: es que no deje nada a medias.
  it("el rechazo no deja lote, ni movimiento, ni asignacion", async () => {
    await editarCatalogo(foto.id, foto.catalogVersion, "caja");

    await registerInventoryEntry(entrada(foto)).catch(() => {});

    expect(await prisma.productBatch.count({ where: { productId: foto.id } })).toBe(0);
    expect(await prisma.inventoryEntry.count({ where: { productId: foto.id } })).toBe(0);
  });

  it("declarando la version nueva, la misma entrada pasa", async () => {
    await editarCatalogo(foto.id, foto.catalogVersion, "caja");
    const actual = await prisma.product.findUniqueOrThrow({ where: { id: foto.id } });

    const result = await registerInventoryEntry(
      entrada({
        id: foto.id,
        identityVersion: actual.identityVersion,
        catalogVersion: actual.catalogVersion,
      }),
    );

    expect(result.entry.id).toBeTruthy();
  });
});

describe("registerInventoryEntry · alguien cambio la identidad en el medio", () => {
  it("rechaza la entrada y dice que fue la IDENTIDAD", async () => {
    const foto = await nuevoProducto("ident");
    // El camino real del remapeo mueve `identityVersion` sin tocar el catalogo.
    await prisma.product.update({
      where: { id: foto.id },
      data: {
        orionCode: `ORN-NUEVO-${randomUUID().slice(0, 8)}`,
        identityVersion: { increment: 1 },
      },
    });

    const rechazo = await registerInventoryEntry(entrada(foto)).catch((e) => e);

    expect(rechazo).toBeInstanceOf(ProductVersionConflictError);
    expect(rechazo.kind).toBe("identity");
    expect(await prisma.productBatch.count({ where: { productId: foto.id } })).toBe(0);
  });
});

describe("registerInventoryEntry · el servidor no le cree al cliente", () => {
  // El SKU y la presentacion que viajan desde el formulario son lo que la
  // persona VIO, no una instruccion. Si el cliente los manipula, el servidor
  // igual escribe y devuelve lo que dice la fila.
  it("devuelve el SKU y la presentacion de la BASE, no los que mando el cliente", async () => {
    const foto = await nuevoProducto("autoridad");
    const real = await prisma.product.findUniqueOrThrow({ where: { id: foto.id } });

    const result = await registerInventoryEntry(
      entrada(foto, {
        displayedSku: "ORN-INVENTADO",
        displayedPresentation: "ampolla-inventada",
      }),
    );

    expect(result.product).toMatchObject({
      orionCode: real.orionCode,
      unit: "frasco",
    });
  });
});

describe("registerInventoryEntry · idempotencia y conflicto de version", () => {
  let foto: Fotografia;
  beforeEach(async () => {
    foto = await nuevoProducto("idem");
  });

  it("dos solicitudes con la misma clave no duplican nada", async () => {
    const datos = entrada(foto, { idempotencyKey: randomUUID() });

    const primera = await registerInventoryEntry(datos);
    const segunda = await registerInventoryEntry(datos);

    expect(segunda.entry.id).toBe(primera.entry.id);
    expect(segunda.idempotent).toBe(true);
    expect(await prisma.inventoryEntry.count({ where: { productId: foto.id } })).toBe(1);
    const lotes = await prisma.productBatch.findMany({ where: { productId: foto.id } });
    expect(lotes).toHaveLength(1);
    expect(lotes[0]!.quantity).toBe(5);
  });

  // Un conflicto de version NO gasta la clave. Si la gastara, corregir y
  // reintentar devolveria "ya esta hecho" sin haber escrito nunca la entrada:
  // la mercaderia quedaria en el deposito y fuera del inventario.
  it("un conflicto de version no consume la clave", async () => {
    const clave = randomUUID();
    await editarCatalogo(foto.id, foto.catalogVersion, "caja");

    await expect(
      registerInventoryEntry(entrada(foto, { idempotencyKey: clave })),
    ).rejects.toBeInstanceOf(ProductVersionConflictError);

    const actual = await prisma.product.findUniqueOrThrow({ where: { id: foto.id } });
    const result = await registerInventoryEntry(
      entrada(
        { id: foto.id, identityVersion: actual.identityVersion, catalogVersion: actual.catalogVersion },
        { idempotencyKey: clave },
      ),
    );

    expect(result.idempotent).toBe(false);
    expect(await prisma.inventoryEntry.count({ where: { productId: foto.id } })).toBe(1);
  });

  it("seis solicitudes simultaneas con la misma clave escriben UNA entrada", async () => {
    const datos = entrada(foto, { idempotencyKey: randomUUID() });

    const resultados = await Promise.allSettled(
      Array.from({ length: 6 }, () => registerInventoryEntry(datos)),
    );

    expect(resultados.filter((r) => r.status === "fulfilled").length).toBeGreaterThan(0);
    expect(await prisma.inventoryEntry.count({ where: { productId: foto.id } })).toBe(1);
    const lotes = await prisma.productBatch.findMany({ where: { productId: foto.id } });
    expect(lotes).toHaveLength(1);
    expect(lotes[0]!.quantity).toBe(5);
  });

  it("cinco entradas simultaneas con la version vieja fallan TODAS sin escribir", async () => {
    await editarCatalogo(foto.id, foto.catalogVersion, "caja");

    const resultados = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        registerInventoryEntry(entrada(foto, { idempotencyKey: randomUUID() })),
      ),
    );

    expect(resultados.every((r) => r.status === "rejected")).toBe(true);
    expect(await prisma.productBatch.count({ where: { productId: foto.id } })).toBe(0);
    expect(await prisma.inventoryEntry.count({ where: { productId: foto.id } })).toBe(0);
  });
});

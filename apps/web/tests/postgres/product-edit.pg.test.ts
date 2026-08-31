import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { editProduct } from "@/server/services/product.service";

// --------------------------------------------------------------------------
// La edición de catálogo, contra PostgreSQL real.
//
// Las dos cosas que se prueban acá NO se pueden probar con un doble:
//
//   CONCURRENCIA. Que el guardado se rechace cuando alguien escribió en el
//   medio depende de que el `where` no encuentre la fila. Un mock devuelve lo
//   que se le pida y no prueba nada.
//
//   IDENTIDAD CANÓNICA del laboratorio. Que "genfar", "Genfar" y "  GENFAR  "
//   resuelvan al mismo laboratorio lo decide la base —plegado de mayúsculas,
//   NFC, clases de blancos Unicode—, y eso no se simula desde TypeScript.
// --------------------------------------------------------------------------

const ACTOR = "actor-edicion";
let productId = "";
let sufijo = "";

beforeEach(async () => {
  sufijo = randomUUID().slice(0, 8);
  const product = await prisma.product.create({
    data: {
      code: `EDIT-${sufijo}`,
      name: "Dolex Niños",
      unit: "unidad",
      minStock: 0,
      reorderQty: 0,
    },
  });
  productId = product.id;
});

afterEach(async () => {
  await prisma.product.deleteMany({ where: { code: { contains: sufijo } } });
  await prisma.laboratory.deleteMany({ where: { name: { contains: sufijo } } });
});

function datos(overrides: Record<string, unknown> = {}) {
  return {
    code: `EDIT-${sufijo}`,
    name: "Dolex Niños",
    unit: "Frasco",
    minStock: 5,
    reorderQty: 20,
    laboratoryId: null,
    active: true,
    actorId: ACTOR,
    ...overrides,
  };
}

async function leerActualizadoAt(): Promise<Date> {
  const row = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  return row.updatedAt;
}

describe("editar producto · el camino feliz", () => {
  it("guarda y devuelve el antes y el después", async () => {
    const testigo = await leerActualizadoAt();

    const result = await editProduct(productId, {
      ...datos(),
      expectedUpdatedAt: testigo,
    });

    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    expect(result.before.unit).toBe("unidad");
    expect(result.after.unit).toBe("Frasco");
    expect(result.after.minStock).toBe(5);
  });

  it("devuelve not_found para un producto que no existe", async () => {
    const result = await editProduct("no-existe", {
      ...datos(),
      expectedUpdatedAt: new Date(),
    });

    expect(result.status).toBe("not_found");
  });
});

// --------------------------------------------------------------------------
// Dos personas editando el mismo producto.
//
// Este formulario manda TODOS los campos, así que la última en guardar
// reescribiría con los valores viejos de su pantalla lo que la otra acaba de
// corregir. Y el `before` de su auditoría no describiría lo que reemplazó.
// --------------------------------------------------------------------------
describe("editar producto · concurrencia", () => {
  it("rechaza el segundo guardado con un testigo viejo", async () => {
    const testigo = await leerActualizadoAt();

    // Bodega guarda primero.
    const primero = await editProduct(productId, {
      ...datos({ name: "Dolex Niños Jarabe" }),
      expectedUpdatedAt: testigo,
    });
    expect(primero.status).toBe("saved");

    // Gerencia tenía la pantalla abierta desde antes y guarda con SU testigo.
    const segundo = await editProduct(productId, {
      ...datos({ minStock: 99 }),
      expectedUpdatedAt: testigo,
    });

    expect(segundo.status).toBe("stale");
  });

  it("el rechazo NO pisa lo que había guardado el primero", async () => {
    const testigo = await leerActualizadoAt();

    await editProduct(productId, {
      ...datos({ name: "Dolex Niños Jarabe" }),
      expectedUpdatedAt: testigo,
    });
    await editProduct(productId, {
      ...datos({ name: "Otro nombre", minStock: 99 }),
      expectedUpdatedAt: testigo,
    });

    const fila = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(fila.name).toBe("Dolex Niños Jarabe");
    expect(fila.minStock).toBe(5);
  });

  it("con el testigo fresco, el segundo guardado sí entra", async () => {
    const primero = await editProduct(productId, {
      ...datos({ name: "Primero" }),
      expectedUpdatedAt: await leerActualizadoAt(),
    });
    expect(primero.status).toBe("saved");

    const segundo = await editProduct(productId, {
      ...datos({ name: "Segundo" }),
      expectedUpdatedAt: await leerActualizadoAt(),
    });

    expect(segundo.status).toBe("saved");
    const fila = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(fila.name).toBe("Segundo");
  });
});

// --------------------------------------------------------------------------
// El laboratorio ESCRITO, no elegido de la lista.
//
// El buscador suelta la selección en cuanto alguien escribe algo distinto de
// lo elegido: manda el id vacío y el texto. Antes de esto, eso se traducía en
// "quitá el laboratorio" con la pantalla mostrando un nombre.
// --------------------------------------------------------------------------
describe("editar producto · el laboratorio escrito a mano", () => {
  it("un nombre escrito sin elegir de la lista CREA el laboratorio y lo vincula", async () => {
    const result = await editProduct(productId, {
      ...datos({ laboratoryId: null }),
      laboratoryName: `Genfar ${sufijo}`,
      expectedUpdatedAt: await leerActualizadoAt(),
    });

    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    expect(result.after.laboratoryId).not.toBeNull();

    const lab = await prisma.laboratory.findUniqueOrThrow({
      where: { id: result.after.laboratoryId! },
    });
    expect(lab.name).toBe(`Genfar ${sufijo}`);
  });

  // Lo que este arreglo viene a impedir.
  it("NO quita el laboratorio en silencio cuando hay un nombre escrito", async () => {
    const lab = await prisma.laboratory.create({ data: { name: `Bayer ${sufijo}` } });
    await prisma.product.update({
      where: { id: productId },
      data: { laboratoryId: lab.id },
    });

    const result = await editProduct(productId, {
      ...datos({ laboratoryId: null }),
      laboratoryName: `Genfar ${sufijo}`,
      expectedUpdatedAt: await leerActualizadoAt(),
    });

    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    expect(result.after.laboratoryId).not.toBeNull();
  });

  // La identidad la calcula la base: dos grafías del mismo nombre no pueden
  // crear dos laboratorios.
  it("reusa el laboratorio existente aunque cambie la capitalización", async () => {
    const existente = await prisma.laboratory.create({ data: { name: `Genfar ${sufijo}` } });

    const result = await editProduct(productId, {
      ...datos({ laboratoryId: null }),
      laboratoryName: `  GENFAR ${sufijo}  `,
      expectedUpdatedAt: await leerActualizadoAt(),
    });

    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    expect(result.after.laboratoryId).toBe(existente.id);

    const cuantos = await prisma.laboratory.count({ where: { name: { contains: sufijo } } });
    expect(cuantos).toBe(1);
  });

  // Sin id y sin texto sí es desvincular: es una edición legítima.
  it("sin id y sin texto, desvincula", async () => {
    const lab = await prisma.laboratory.create({ data: { name: `Bayer ${sufijo}` } });
    await prisma.product.update({
      where: { id: productId },
      data: { laboratoryId: lab.id },
    });

    const result = await editProduct(productId, {
      ...datos({ laboratoryId: null }),
      expectedUpdatedAt: await leerActualizadoAt(),
    });

    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    expect(result.after.laboratoryId).toBeNull();
  });

  // Atomicidad: si el guardado se rechaza por concurrencia, no puede quedar un
  // laboratorio suelto que nadie pidió.
  it("un rechazo por concurrencia NO deja el laboratorio creado", async () => {
    const testigo = await leerActualizadoAt();
    await editProduct(productId, {
      ...datos({ name: "Alguien más" }),
      expectedUpdatedAt: testigo,
    });

    const result = await editProduct(productId, {
      ...datos({ laboratoryId: null }),
      laboratoryName: `Huerfano ${sufijo}`,
      expectedUpdatedAt: testigo,
    });

    expect(result.status).toBe("stale");
    const cuantos = await prisma.laboratory.count({
      where: { name: { contains: `Huerfano ${sufijo}` } },
    });
    expect(cuantos).toBe(0);
  });
});

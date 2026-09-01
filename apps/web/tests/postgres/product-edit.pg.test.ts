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

async function leerVersion(): Promise<number> {
  const row = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  return row.catalogVersion;
}

describe("editar producto · el camino feliz", () => {
  it("guarda y devuelve el antes y el después", async () => {
    const version = await leerVersion();

    const result = await editProduct(productId, {
      ...datos(),
      expectedVersion: version,
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
      expectedVersion: 0,
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
    const version = await leerVersion();

    // Bodega guarda primero.
    const primero = await editProduct(productId, {
      ...datos({ name: "Dolex Niños Jarabe" }),
      expectedVersion: version,
    });
    expect(primero.status).toBe("saved");

    // Gerencia tenía la pantalla abierta desde antes y guarda con SU testigo.
    const segundo = await editProduct(productId, {
      ...datos({ minStock: 99 }),
      expectedVersion: version,
    });

    expect(segundo.status).toBe("stale");
  });

  it("el rechazo NO pisa lo que había guardado el primero", async () => {
    const version = await leerVersion();

    await editProduct(productId, {
      ...datos({ name: "Dolex Niños Jarabe" }),
      expectedVersion: version,
    });
    await editProduct(productId, {
      ...datos({ name: "Otro nombre", minStock: 99 }),
      expectedVersion: version,
    });

    const fila = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(fila.name).toBe("Dolex Niños Jarabe");
    expect(fila.minStock).toBe(5);
  });

  it("con el testigo fresco, el segundo guardado sí entra", async () => {
    const primero = await editProduct(productId, {
      ...datos({ name: "Primero" }),
      expectedVersion: await leerVersion(),
    });
    expect(primero.status).toBe("saved");

    const segundo = await editProduct(productId, {
      ...datos({ name: "Segundo" }),
      expectedVersion: await leerVersion(),
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
      expectedVersion: await leerVersion(),
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
      expectedVersion: await leerVersion(),
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
      expectedVersion: await leerVersion(),
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
      expectedVersion: await leerVersion(),
    });

    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    expect(result.after.laboratoryId).toBeNull();
  });

  // Atomicidad: si el guardado se rechaza por concurrencia, no puede quedar un
  // laboratorio suelto que nadie pidió.
  it("un rechazo por concurrencia NO deja el laboratorio creado", async () => {
    const version = await leerVersion();
    await editProduct(productId, {
      ...datos({ name: "Alguien más" }),
      expectedVersion: version,
    });

    const result = await editProduct(productId, {
      ...datos({ laboratoryId: null }),
      laboratoryName: `Huerfano ${sufijo}`,
      expectedVersion: version,
    });

    expect(result.status).toBe("stale");
    const cuantos = await prisma.laboratory.count({
      where: { name: { contains: `Huerfano ${sufijo}` } },
    });
    expect(cuantos).toBe(0);
  });
});

// --------------------------------------------------------------------------
// El compare-and-set, sobre la versión ENTERA.
//
// Antes el testigo era `updatedAt`, y eso confundía dos cosas: una marca de
// tiempo dice CUÁNDO pasó algo, no en qué ORDEN. `TIMESTAMP(3)` tiene
// resolución de milisegundo y PostgreSQL no promete que dos escrituras rápidas
// caigan en milisegundos distintos. Medirlo tampoco alcanzaba como garantía:
// cuarenta escrituras sin colisión son una muestra, no una promesa del motor.
//
// Estas pruebas fuerzan la colisión a mano en vez de esperarla.
// --------------------------------------------------------------------------
describe("editar producto · el CAS no depende del reloj", () => {
  it("dos escrituras con la MISMA marca temporal no lo rompen", async () => {
    const version = await leerVersion();

    // Se fija `updatedAt` a un valor conocido y se guarda; después se vuelve a
    // fijar al MISMO valor. Con un control basado en fechas, el segundo intento
    // con el testigo viejo pasaría. Con la versión entera, no.
    const congelado = new Date("2026-09-01T10:00:00.000Z");
    await prisma.$executeRaw`
      UPDATE products SET "updatedAt" = ${congelado} WHERE id = ${productId}
    `;

    const primero = await editProduct(productId, {
      ...datos({ name: "Primera escritura" }),
      expectedVersion: version,
    });
    expect(primero.status).toBe("saved");

    await prisma.$executeRaw`
      UPDATE products SET "updatedAt" = ${congelado} WHERE id = ${productId}
    `;

    // Misma marca temporal que antes del primer guardado: un control por fecha
    // no vería diferencia. El de versión sí.
    const segundo = await editProduct(productId, {
      ...datos({ name: "Segunda escritura" }),
      expectedVersion: version,
    });

    expect(segundo.status).toBe("stale");
    const fila = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(fila.name).toBe("Primera escritura");
  });

  it("la versión avanza de a uno en cada guardado", async () => {
    const inicial = await leerVersion();

    await editProduct(productId, { ...datos({ name: "A" }), expectedVersion: inicial });
    expect(await leerVersion()).toBe(inicial + 1);

    await editProduct(productId, { ...datos({ name: "B" }), expectedVersion: inicial + 1 });
    expect(await leerVersion()).toBe(inicial + 2);
  });

  it("dos sesiones desde N: la primera produce N+1, la segunda es rechazada", async () => {
    const n = await leerVersion();

    const sesionA = await editProduct(productId, {
      ...datos({ name: "Sesión A" }),
      expectedVersion: n,
    });
    const sesionB = await editProduct(productId, {
      ...datos({ minStock: 99 }),
      expectedVersion: n,
    });

    expect(sesionA.status).toBe("saved");
    expect(sesionB.status).toBe("stale");
    expect(await leerVersion()).toBe(n + 1);

    const fila = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(fila.name).toBe("Sesión A");
    expect(fila.minStock).toBe(5);
  });

  it("el rechazo no avanza la versión: nada se escribió", async () => {
    const n = await leerVersion();
    await editProduct(productId, { ...datos(), expectedVersion: n + 7 });

    expect(await leerVersion()).toBe(n);
  });

  // Concurrencia de verdad: dos guardados disparados a la vez sobre la misma
  // versión. Exactamente uno tiene que ganar.
  it("dos guardados simultáneos desde la misma versión: gana UNO", async () => {
    const n = await leerVersion();

    const [a, b] = await Promise.all([
      editProduct(productId, { ...datos({ name: "Simultáneo A" }), expectedVersion: n }),
      editProduct(productId, { ...datos({ name: "Simultáneo B" }), expectedVersion: n }),
    ]);

    const estados = [a.status, b.status].sort();
    expect(estados).toEqual(["saved", "stale"]);
    expect(await leerVersion()).toBe(n + 1);
  });

  it("seis guardados simultáneos: uno gana, cinco son rechazados", async () => {
    const n = await leerVersion();

    const resultados = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        editProduct(productId, {
          ...datos({ name: `Concurrente ${i}` }),
          expectedVersion: n,
        }),
      ),
    );

    expect(resultados.filter((r) => r.status === "saved")).toHaveLength(1);
    expect(resultados.filter((r) => r.status === "stale")).toHaveLength(5);
    expect(await leerVersion()).toBe(n + 1);
  });
});

// --------------------------------------------------------------------------
// Dos ciclos independientes: identidad y catálogo.
//
// `identityVersion` protege el vínculo con el código de Orion; `catalogVersion`
// protege la edición de catálogo. Compartir contador acoplaría dos decisiones
// que ocurren en pantallas distintas: vincular un SKU invalidaría una
// corrección de nombre a medio escribir, y al revés.
// --------------------------------------------------------------------------
describe("editar producto · identidad y catálogo no se pisan", () => {
  it("editar el catálogo NO mueve identityVersion", async () => {
    const antes = await prisma.product.findUniqueOrThrow({ where: { id: productId } });

    await editProduct(productId, {
      ...datos({ name: "Editado" }),
      expectedVersion: antes.catalogVersion,
    });

    const despues = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(despues.identityVersion).toBe(antes.identityVersion);
    expect(despues.catalogVersion).toBe(antes.catalogVersion + 1);
  });

  it("mover identityVersion NO invalida una edición de catálogo en curso", async () => {
    const version = await leerVersion();

    // Alguien vincula el SKU: avanza la identidad, no el catálogo.
    await prisma.product.update({
      where: { id: productId },
      data: { orionCode: `ORN-${sufijo}`, identityVersion: { increment: 1 } },
    });

    // La edición de catálogo que estaba abierta sigue siendo válida.
    const result = await editProduct(productId, {
      ...datos({ name: "Editado igual" }),
      expectedVersion: version,
    });

    expect(result.status).toBe("saved");
  });

  it("editar el catálogo no toca el código de Orion", async () => {
    await prisma.product.update({
      where: { id: productId },
      data: { orionCode: `ORN2-${sufijo}` },
    });

    await editProduct(productId, {
      ...datos({ name: "Otro nombre" }),
      expectedVersion: await leerVersion(),
    });

    const fila = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(fila.orionCode).toBe(`ORN2-${sufijo}`);
  });
});

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  laboratoryCreateCommandKey,
  normalizeLaboratoryName,
} from "@/server/domain/laboratory/identity";
import {
  LaboratoryResolutionInvariantError,
  findOrCreateLaboratory,
} from "@/server/repositories/laboratory.repository";

// --------------------------------------------------------------------------
// Creación idempotente de laboratorios, contra PostgreSQL real.
//
// Se prueba acá y no con mocks porque lo que decide el resultado son los TRES
// índices únicos de la tabla —`searchKey` y `createCommandKey`, parciales, y
// `name`, total— y un mock no choca contra un índice. Ese fue exactamente el hueco: la suite
// mockeada estaba en verde mientras el segundo laboratorio de un mismo usuario
// reventaba.
// --------------------------------------------------------------------------

const USER = "user-lab-repo";
const OTHER_USER = "user-lab-repo-2";

// Sufijo por corrida: la base es descartable pero se comparte entre archivos,
// y un nombre fijo haría que la segunda corrida encontrara la fila de la
// primera y probara otra cosa.
const RUN = randomUUID().slice(0, 8);
const named = (label: string) => `Lab ${label} ${RUN}`;

afterEach(async () => {
  await prisma.laboratory.deleteMany({
    where: { name: { contains: RUN } },
  });
});

// --------------------------------------------------------------------------
// El defecto que motivó esta corrección.
//
// `createCommandKey` es único. Con una clave constante por usuario, el SEGUNDO
// laboratorio que esa persona crea choca contra ese índice —no contra
// `searchKey`— y el camino de conflicto lo trataba como una carrera perdida:
// releía por `searchKey`, no encontraba nada, y relanzaba el error.
// --------------------------------------------------------------------------
describe("findOrCreateLaboratory · dos laboratorios del mismo usuario", () => {
  it("la vía AUTOMÁTICA deja crear un segundo laboratorio distinto", async () => {
    const first = await findOrCreateLaboratory({
      name: named("Auto Uno"),
      commandKey: laboratoryCreateCommandKey("auto", USER, named("Auto Uno")),
    });
    const second = await findOrCreateLaboratory({
      name: named("Auto Dos"),
      commandKey: laboratoryCreateCommandKey("auto", USER, named("Auto Dos")),
    });

    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    expect(second.laboratory.id).not.toBe(first.laboratory.id);
  });

  it("la vía MANUAL deja crear un segundo laboratorio distinto", async () => {
    const first = await findOrCreateLaboratory({
      name: named("Manual Uno"),
      commandKey: laboratoryCreateCommandKey("manual", USER, named("Manual Uno")),
    });
    const second = await findOrCreateLaboratory({
      name: named("Manual Dos"),
      commandKey: laboratoryCreateCommandKey("manual", USER, named("Manual Dos")),
    });

    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    expect(second.laboratory.id).not.toBe(first.laboratory.id);
  });

  it("dos usuarios distintos pueden crear el MISMO laboratorio sin pisarse", async () => {
    const name = named("Compartido");
    const mine = await findOrCreateLaboratory({
      name,
      commandKey: laboratoryCreateCommandKey("auto", USER, name),
    });
    const theirs = await findOrCreateLaboratory({
      name,
      commandKey: laboratoryCreateCommandKey("auto", OTHER_USER, name),
    });

    expect(mine.status).toBe("created");
    expect(theirs.status).toBe("exists");
    expect(theirs.laboratory.id).toBe(mine.laboratory.id);
  });
});

describe("findOrCreateLaboratory · idempotencia", () => {
  it("un nombre ya existente devuelve exists sin insertar otra fila", async () => {
    const name = named("Repetido");
    const key = laboratoryCreateCommandKey("auto", USER, name);

    const first = await findOrCreateLaboratory({ name, commandKey: key });
    const again = await findOrCreateLaboratory({ name, commandKey: key });

    expect(first.status).toBe("created");
    expect(again.status).toBe("exists");
    expect(again.laboratory.id).toBe(first.laboratory.id);
    expect(
      await prisma.laboratory.count({
        where: { searchKey: normalizeLaboratoryName(name) },
      }),
    ).toBe(1);
  });

  it("dos creaciones CONCURRENTES del mismo nombre dejan una sola fila", async () => {
    const name = named("Carrera");
    const key = laboratoryCreateCommandKey("auto", USER, name);

    // Sin `$transaction` de por medio, estas dos consultas sí se solapan de
    // verdad: quien serializa es el índice único, no el orden del código.
    const [a, b] = await Promise.all([
      findOrCreateLaboratory({ name, commandKey: key }),
      findOrCreateLaboratory({ name, commandKey: key }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["created", "exists"]);
    expect(a.laboratory.id).toBe(b.laboratory.id);
    expect(
      await prisma.laboratory.count({
        where: { searchKey: normalizeLaboratoryName(name) },
      }),
    ).toBe(1);
  });

  // El mismo comando pidiendo OTRO nombre no es una carrera: es un intento que
  // cambió de idea. Devolver el laboratorio viejo como si nada sería la
  // sustitución silenciosa que queremos evitar, así que se nombra.
  it("el mismo commandKey con otro nombre devuelve exact_name_exists", async () => {
    const key = `shared:${RUN}`;

    const first = await findOrCreateLaboratory({ name: named("Original"), commandKey: key });
    const reused = await findOrCreateLaboratory({ name: named("Cambiado"), commandKey: key });

    expect(first.status).toBe("created");
    expect(reused.status).toBe("exact_name_exists");
    expect(reused.laboratory.id).toBe(first.laboratory.id);
    expect(
      await prisma.laboratory.count({
        where: { searchKey: normalizeLaboratoryName(named("Cambiado")) },
      }),
    ).toBe(0);
  });
});

// --------------------------------------------------------------------------
// La propiedad que hace posible resolver laboratorios DENTRO de una
// transacción más grande: en PostgreSQL un error aborta la transacción entera
// y toda consulta posterior falla con 25P02. El camino de conflicto esperado
// no puede pasar por un error.
// --------------------------------------------------------------------------
describe("findOrCreateLaboratory · dentro de una transacción", () => {
  it("un conflicto esperado NO aborta la transacción que lo contiene", async () => {
    const name = named("EnTransaccion");
    const key = laboratoryCreateCommandKey("auto", USER, name);
    await findOrCreateLaboratory({ name, commandKey: key });

    const result = await prisma.$transaction(async (tx) => {
      const conflicted = await findOrCreateLaboratory({ name, commandKey: key }, tx);
      // Si el conflicto hubiera abortado la transacción, esta consulta
      // fallaría con 25P02 en vez de responder.
      const stillUsable = await tx.laboratory.count({
        where: { searchKey: normalizeLaboratoryName(name) },
      });
      return { conflicted, stillUsable };
    });

    expect(result.conflicted.status).toBe("exists");
    expect(result.stillUsable).toBe(1);
  });
});

// --------------------------------------------------------------------------
// Camino defensivo: el INSERT no insertó y ninguna de las dos claves resuelve.
// Por vía natural no ocurre —un conflicto por `searchKey` siempre lo encuentra
// el SELECT por `searchKey`, y lo mismo con `createCommandKey`—; ocurriría solo
// si alguien borrara la fila en el medio. Se prueba forzando ese estado a
// través del parámetro `client`, que ya es parte de la firma pública, para que
// el invariante roto tenga un error propio y no un `undefined` más adelante.
// --------------------------------------------------------------------------
describe("findOrCreateLaboratory · invariante", () => {
  it("falla con un error explícito si el conflicto no resuelve a ninguna fila", async () => {
    const name = named("Invariante");
    const key = laboratoryCreateCommandKey("auto", USER, name);
    await findOrCreateLaboratory({ name, commandKey: key });

    const blindClient = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === "laboratory") {
          const model = Reflect.get(target, property, receiver);
          return { ...model, findUnique: async () => null, findFirst: async () => null };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as typeof prisma;

    await expect(
      findOrCreateLaboratory({ name, commandKey: key }, blindClient),
    ).rejects.toBeInstanceOf(LaboratoryResolutionInvariantError);
  });
});

// --------------------------------------------------------------------------
// Laboratorios anteriores a la migración de trazabilidad.
//
// `20260826190000_add_laboratory_traceability` agrega `searchKey` como columna
// nullable y NO rellena las filas que ya estaban. Todo laboratorio anterior
// queda con `searchKey` NULL, y el índice único de `searchKey` es PARCIAL, así
// que esa fila no ocupa ninguna clave de búsqueda.
//
// El que sí ocupa es `laboratories_name_key`: total, sobre una columna NOT
// NULL, y existe desde la primera migración de la tabla. Resolver un
// laboratorio histórico choca contra ÉL, no contra `searchKey` — y ninguna de
// las dos lecturas del camino de conflicto lo encuentra.
// --------------------------------------------------------------------------
describe("findOrCreateLaboratory · laboratorios previos a la migración", () => {
  it("resuelve una fila histórica con searchKey NULL en vez de romper", async () => {
    const name = named("Historico");
    const legacy = await prisma.laboratory.create({
      data: { name, searchKey: null },
    });

    const result = await findOrCreateLaboratory({
      name,
      commandKey: laboratoryCreateCommandKey("auto", USER, name),
    });

    expect(result.status).toBe("exists");
    expect(result.laboratory.id).toBe(legacy.id);
    expect(await prisma.laboratory.count({ where: { name } })).toBe(1);
  });

  it("no confunde una fila histórica con el nombre que otro comando pidió", async () => {
    const legacyName = named("Historico Otro");
    await prisma.laboratory.create({
      data: { name: legacyName, searchKey: null },
    });

    const fresh = named("Historico Nuevo");
    const result = await findOrCreateLaboratory({
      name: fresh,
      commandKey: laboratoryCreateCommandKey("auto", OTHER_USER, fresh),
    });

    expect(result.status).toBe("created");
    expect(result.laboratory.searchKey).toBe(normalizeLaboratoryName(fresh));
  });
});

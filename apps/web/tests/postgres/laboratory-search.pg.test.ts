import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { searchLaboratories } from "@/server/repositories/laboratory.repository";
import type { LaboratoryCandidate } from "@/server/domain/laboratory/identity";

// Tests de PostgreSQL real para searchLaboratories.
// El objective: probar que la query parameterizada funciona correctamente,
// que escapa metacaracteres LIKE, y que los errores reales de DB no se
// confunden con resultados vacíos.

function first<T>(arr: T[]): T {
  const item = arr[0];
  if (item === undefined) throw new Error("Expected non-empty array");
  return item;
}

// `searchKey` no se manda: la deriva un trigger desde el nombre. El segundo
// parámetro se conserva para no reescribir cada llamada, pero se ignora.
async function createLab(
  name: string,
  _searchKeyIgnorado?: string,
  needsReview = false,
): Promise<string> {
  const lab = await prisma.laboratory.create({
    data: { name, needsReview },
  });
  return lab.id;
}

afterEach(async () => {
  await prisma.laboratory.deleteMany({});
});

describe("searchLaboratories", () => {
  it("devuelve coincidencia exacta por searchKey", async () => {
    const id = await createLab("MK Pharma", "mk pharma");

    const results = await searchLaboratories("MK Pharma");

    expect(results).toHaveLength(1);
    expect(first(results).id).toBe(id);
    expect(first(results).name).toBe("MK Pharma");
  });

  it("devuelve coincidencia parcial por nombre", async () => {
    const id = await createLab("Genfar Laboratories", "genfar laboratories");

    const results = await searchLaboratories("gen");

    expect(results).toHaveLength(1);
    expect(first(results).id).toBe(id);
    expect(first(results).name).toBe("Genfar Laboratories");
  });

  it("ordena coincidencias exactas primero y alfabéticamente después", async () => {
    const idExact = await createLab("MK", "mk");
    await createLab("MK Pharma", "mk pharma");
    await createLab("Mk Global", "mk global");

    const results = await searchLaboratories("mk");

    expect(results.length).toBeGreaterThanOrEqual(2);
    // La primera debe ser la coincidencia exacta
    expect(first(results).id).toBe(idExact);
  });

  it("limita a 8 resultados", async () => {
    // Crear 10 laboratorios que matchean "lab"
    for (let i = 0; i < 10; i++) {
      await createLab(`Lab ${String(i).padStart(2, "0")}`, `lab ${String(i).padStart(2, "0")}`);
    }

    const results = await searchLaboratories("lab");

    expect(results).toHaveLength(8);
  });

  it("encuentra nombres con metacaracteres LIKE", async () => {
    const id = await createLab("100% Natural", "100% natural");

    const results = await searchLaboratories("100%");

    expect(results).toHaveLength(1);
    expect(first(results).id).toBe(id);
  });

  it("escapa guiones bajos en LIKE", async () => {
    const id = await createLab("MK_Extra", "mk_extra");

    const results = await searchLaboratories("MK_Extra");

    expect(results).toHaveLength(1);
    expect(first(results).id).toBe(id);
  });

  it("guion bajo no se comporta como wildcard en LIKE", async () => {
    // Crear labs con nombres similares pero identities distintas
    const idExact = await createLab("MK_Pharma", "mk_pharma");
    await createLab("MK Pharma", "mk pharma");  // espacio, no guión bajo

    // Buscar "MK_Pharma" → normaliza a "mk_pharma"
    // El _ NO debe matchear el espacio de "mk pharma"
    const results = await searchLaboratories("MK_Pharma");

    expect(results).toHaveLength(1);
    expect(first(results).id).toBe(idExact);
    expect(first(results).name).toBe("MK_Pharma");
  });

  it("retorna array vacío cuando no hay coincidencias", async () => {
    await createLab("Genfar", "genfar");

    const results = await searchLaboratories("xyz123");

    expect(results).toHaveLength(0);
  });

  it("no muta la base en caso de input adversarial", async () => {
    const id = await createLab("MK", "mk");
    const countBefore = await prisma.laboratory.count();

    // SQL injection — no debe afectar filas
    const results = await searchLaboratories("mk' OR '1'='1");

    expect(results).toHaveLength(0);
    const countAfter = await prisma.laboratory.count();
    expect(countAfter).toBe(countBefore);
    // Verificar que MK sigue existiendo
    const mkStillExists = await prisma.laboratory.findUnique({ where: { id } });
    expect(mkStillExists).not.toBeNull();
  });

  it("devuelve vacío con query vacía o solo espacios", async () => {
    await createLab("MK", "mk");

    const results1 = await searchLaboratories("");
    const results2 = await searchLaboratories("   ");

    expect(results1).toHaveLength(0);
    expect(results2).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// El carácter de escape, como literal.
//
// `escapeLike` duplica `!` además de `%` y `_`. Si no lo hiciera, un `!` del
// operador se comería el carácter siguiente y la búsqueda encontraría cosas
// que nadie pidió.
// --------------------------------------------------------------------------
describe("searchLaboratories · el carácter de escape", () => {
  it("encuentra un nombre que contiene el propio '!'", async () => {
    const id = await createLab("Lab !Alpha", "lab !alpha");
    await createLab("Lab Alpha", "lab alpha");

    const results = await searchLaboratories("!alpha");

    expect(results).toHaveLength(1);
    expect(first(results).id).toBe(id);
  });

  it("'!' no consume el carácter siguiente", async () => {
    await createLab("Lab X%Y", "lab x%y");

    // Sin escapar el '!', el patrón `!%` sería "un % literal" y traería la
    // fila de arriba. Escapado, `!` es un carácter más y no hay coincidencia.
    const results = await searchLaboratories("!%");

    expect(results).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// Los cuatro escalones del orden, en una sola corrida.
// --------------------------------------------------------------------------
describe("searchLaboratories · orden por escalones", () => {
  it("ordena exacto, luego prefijo, luego contiene, luego alfabético", async () => {
    await createLab("Zeta Mk", "zeta mk");        // contiene
    await createLab("Mk Pharma", "mk pharma");    // prefijo
    await createLab("Alfa Mk", "alfa mk");        // contiene, antes alfabético
    await createLab("Mk", "mk");                  // exacto
    await createLab("Mk Global", "mk global");    // prefijo, antes alfabético

    const results = await searchLaboratories("mk");

    expect(results.map((r) => r.name)).toEqual([
      "Mk",
      "Mk Global",
      "Mk Pharma",
      "Alfa Mk",
      "Zeta Mk",
    ]);
  });
});

// --------------------------------------------------------------------------
// Una base rota se ve como base rota.
//
// El caso real pre-trazabilidad es una COLUMNA que falta (`42703`), no una
// tabla. Y Prisma 7 pone `P2010` en `.code`, con el SQLSTATE escondido en
// `meta.driverAdapterError.cause.originalCode`. Se prueba con el error de
// verdad, emitido por PostgreSQL, no con uno inventado.
// --------------------------------------------------------------------------
describe("searchLaboratories · errores de base", () => {
  it("una columna faltante NO se convierte en 'sin resultados'", async () => {
    const failing = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === "$queryRaw") {
          return () =>
            prisma.$queryRaw`SELECT "columnaAusente" FROM laboratories LIMIT 1`;
        }
        return Reflect.get(target, property, receiver);
      },
    }) as typeof prisma;

    await expect(searchLaboratories("mk", failing)).rejects.toMatchObject({
      code: "P2010",
      meta: {
        driverAdapterError: { cause: { originalCode: "42703" } },
      },
    });
  });
});

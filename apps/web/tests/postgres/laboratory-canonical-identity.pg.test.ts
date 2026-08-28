import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { laboratoryCreateCommandKey } from "@/server/domain/laboratory/identity";
import { findOrCreateLaboratory } from "@/server/repositories/laboratory.repository";

// --------------------------------------------------------------------------
// La identidad canónica, defendida por el ESQUEMA.
//
// Antes de `20260828120000_add_laboratory_canonical_identity` la base dejaba
// convivir "Bayer" y "bayer" como dos laboratorios distintos: el índice de
// `name` es sensible a mayúsculas y el de `searchKey` era PARCIAL, así que una
// fila con `searchKey` NULL no ocupaba ninguna clave de búsqueda. El dominio
// decía "es el mismo laboratorio" y la base decía que no.
//
// Estas pruebas van contra PostgreSQL real porque lo que decide el resultado
// es un índice, y un mock no choca contra un índice.
// --------------------------------------------------------------------------

const USER = "user-canonical";

// Sufijo por corrida: la base es descartable pero se comparte entre archivos.
const RUN = randomUUID().slice(0, 8);

afterEach(async () => {
  await prisma.laboratory.deleteMany({ where: { name: { contains: RUN } } });
});

async function resolve(name: string) {
  return findOrCreateLaboratory({
    name,
    commandKey: laboratoryCreateCommandKey("auto", USER, name),
  });
}

async function countNamed(fragment: string): Promise<number> {
  return prisma.laboratory.count({ where: { name: { contains: fragment } } });
}

// --------------------------------------------------------------------------
// Las variantes que el dominio considera el MISMO laboratorio.
// --------------------------------------------------------------------------
describe("identidad canónica · variantes del mismo nombre", () => {
  it("'Bayer' y 'bayer' son el mismo laboratorio", async () => {
    const primero = await resolve(`Bayer ${RUN}`);
    const segundo = await resolve(`bayer ${RUN}`);

    expect(primero.status).toBe("created");
    expect(segundo.status).toBe("exists");
    expect(segundo.laboratory.id).toBe(primero.laboratory.id);
    expect(await countNamed(RUN)).toBe(1);
  });

  it("el espacio interno de más no crea un laboratorio nuevo", async () => {
    const primero = await resolve(`Lab  Doble ${RUN}`);
    const segundo = await resolve(`Lab Doble ${RUN}`);

    expect(primero.status).toBe("created");
    expect(segundo.status).toBe("exists");
    expect(segundo.laboratory.id).toBe(primero.laboratory.id);
    expect(await countNamed(RUN)).toBe(1);
  });

  it("los blancos raros —tab, NBSP— tampoco", async () => {
    const primero = await resolve(`Lab\tRaro ${RUN}`);
    const segundo = await resolve(`Lab Raro ${RUN}`);

    expect(primero.status).toBe("created");
    expect(segundo.status).toBe("exists");
    expect(segundo.laboratory.id).toBe(primero.laboratory.id);
    expect(await countNamed(RUN)).toBe(1);
  });

  it("nombres realmente distintos siguen siendo distintos", async () => {
    const uno = await resolve(`Bayer ${RUN}`);
    const otro = await resolve(`Bayer Chile ${RUN}`);

    expect(uno.status).toBe("created");
    expect(otro.status).toBe("created");
    expect(otro.laboratory.id).not.toBe(uno.laboratory.id);
    expect(await countNamed(RUN)).toBe(2);
  });
});

// --------------------------------------------------------------------------
// Concurrencia sobre una fila que todavía no existe.
//
// Es el caso que importa: dos capturas simultáneas del mismo laboratorio
// escrito distinto. El `ON CONFLICT DO NOTHING` sin target absorbe el choque
// sin abortar la transacción, y la lectura por identidad resuelve a la misma
// fila para los dos.
// --------------------------------------------------------------------------
describe("identidad canónica · concurrencia", () => {
  it("dos capturas simultáneas con distinta capitalización dejan UNA fila", async () => {
    const [a, b] = await Promise.all([
      resolve(`Concurrente ${RUN}`),
      resolve(`CONCURRENTE ${RUN}`),
    ]);

    expect(await countNamed(RUN)).toBe(1);
    expect(a.laboratory.id).toBe(b.laboratory.id);
    expect([a.status, b.status].sort()).toEqual(["created", "exists"]);
  });

  it("seis capturas simultáneas con variantes de espacio dejan UNA fila", async () => {
    const variantes = [
      `Multi ${RUN}`,
      `multi ${RUN}`,
      `  Multi ${RUN}  `,
      `MULTI  ${RUN}`,
      `Multi\t${RUN}`,
      `mUlTi ${RUN}`,
    ];

    const resultados = await Promise.all(variantes.map((v) => resolve(v)));

    expect(await countNamed(RUN)).toBe(1);
    const ids = new Set(resultados.map((r) => r.laboratory.id));
    expect(ids.size).toBe(1);
    expect(resultados.filter((r) => r.status === "created")).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// La base rechaza por su cuenta, sin pasar por el repositorio.
//
// Importa que la garantía NO dependa del código de la aplicación: un script,
// una consola de psql o un servicio futuro que inserte directo tiene que
// chocar igual.
// --------------------------------------------------------------------------
describe("identidad canónica · el esquema rechaza solo", () => {
  it("un INSERT directo con la misma identidad es rechazado", async () => {
    const name = `Directo ${RUN}`;
    await resolve(name);

    await expect(
      prisma.laboratory.create({ data: { name: name.toUpperCase() } }),
    ).rejects.toThrow();

    expect(await countNamed(RUN)).toBe(1);
  });

  it("renombrar re-deriva searchKey: el trigger corre también en UPDATE", async () => {
    const original = `Renombrado ${RUN}`;
    const creado = await resolve(original);

    const nuevo = `RENOMBRADO OTRO ${RUN}`;
    await prisma.laboratory.update({
      where: { id: creado.laboratory.id },
      data: { name: nuevo },
    });

    const fila = await prisma.laboratory.findUniqueOrThrow({
      where: { id: creado.laboratory.id },
    });
    const [esperado] = await prisma.$queryRaw<{ v: string }[]>`
      SELECT laboratory_canonical_identity(${nuevo}) AS v
    `;

    expect(fila.searchKey).toBe(esperado?.v);
  });

  it("tras renombrar, la identidad vieja queda libre para OTRO comando", async () => {
    const original = `Libera ${RUN}`;
    const creado = await resolve(original);
    await prisma.laboratory.update({
      where: { id: creado.laboratory.id },
      data: { name: `Libera Movido ${RUN}` },
    });

    // Otro actor: su commandKey es distinto, así que nada bloquea el INSERT y
    // el nombre viejo vuelve a estar disponible como identidad nueva.
    const reusado = await findOrCreateLaboratory({
      name: original,
      commandKey: laboratoryCreateCommandKey("auto", "otro-actor", original),
    });

    expect(reusado.status).toBe("created");
    expect(reusado.laboratory.id).not.toBe(creado.laboratory.id);
  });

  // `exact_name_exists` SÍ es alcanzable, y este es el camino: el mismo actor
  // pide el mismo nombre después de que ese laboratorio fue renombrado. Su
  // commandKey lleva el nombre viejo, así que bloquea el INSERT, pero la fila
  // que ocupa esa clave hoy se llama distinto. Devolverla en silencio sería
  // entregarle a la persona un laboratorio que no pidió.
  it("el mismo comando, tras un renombrado, devuelve exact_name_exists", async () => {
    const original = `Reclama ${RUN}`;
    const creado = await resolve(original);
    await prisma.laboratory.update({
      where: { id: creado.laboratory.id },
      data: { name: `Reclama Movido ${RUN}` },
    });

    const reintento = await resolve(original);

    expect(reintento.status).toBe("exact_name_exists");
    expect(reintento.laboratory.id).toBe(creado.laboratory.id);
    expect(reintento.laboratory.name).not.toBe(original);
  });

  it("el trigger, el CHECK y el único TOTAL están en el catálogo", async () => {
    const triggers = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'laboratories'::regclass
         AND tgname = 'laboratories_canonical_identity_sync'
         AND NOT tgisinternal
    `;
    expect(triggers).toHaveLength(1);

    const checks = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'laboratories'::regclass
         AND conname = 'laboratories_searchKey_canonical_check'
    `;
    expect(checks).toHaveLength(1);

    // TOTAL, no parcial: con la columna NOT NULL, un `WHERE ... IS NOT NULL`
    // sería una condición siempre verdadera de la que dependería el plan.
    const indices = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'laboratories'
         AND indexname = 'laboratories_searchKey_key'
    `;
    expect(indices).toHaveLength(1);
    expect(indices[0]?.indexdef).not.toContain("WHERE");

    // La función es la ÚNICA definición de la regla: tiene que existir y ser
    // IMMUTABLE, o el índice y el CHECK no podrían apoyarse en ella.
    const funciones = await prisma.$queryRaw<{ volatilidad: string }[]>`
      SELECT provolatile::text AS volatilidad FROM pg_proc
       WHERE proname = 'laboratory_canonical_identity'
    `;
    expect(funciones).toHaveLength(1);
    expect(funciones[0]?.volatilidad).toBe("i");
  });

  it("searchKey quedó NOT NULL", async () => {
    const columnas = await prisma.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'laboratories' AND column_name = 'searchKey'
    `;
    expect(columnas[0]?.is_nullable).toBe("NO");
  });
});

// --------------------------------------------------------------------------
// Unicode: una sola definición, la de la base.
//
// Mantener la misma regla en TypeScript y en PostgreSQL resultó imposible.
// Verificado contra PostgreSQL 18 con lc_ctype en_US.utf8:
//
//   "ΟΣ"        JS -> 03bf 03c2 (sigma FINAL)  PG -> 03bf 03c3
//   "İ"              JS -> 0069 0307 (largo 2)      PG -> 0069 (largo 1)
//   "AB"            JS conserva U+0085             PG lo colapsa a espacio
//   "é" / "é"  distintos en AMBOS: ninguno normalizaba a NFC
//
// Las dos primeras son reglas de plegado de mayusculas que dependen de la
// version de Unicode y del ICU del servidor: no son reproducibles desde
// TypeScript. Por eso la identidad la calcula SOLO la base, y estas pruebas
// verifican comportamiento observable -crear, reencontrar, no duplicar- en vez
// de comparar dos implementaciones que no pueden coincidir.
// --------------------------------------------------------------------------
describe("identidad canonica · Unicode", () => {
  const RAROS: [string, string][] = [
    ["sigma final griega", "ΟΣ"],
    ["I mayuscula con punto", "İstanbul"],
    ["NEL U+0085", "AB"],
    ["NBSP", "Lab NBSP"],
    ["espacio ideografico", "Lab　Ideo"],
    ["BOM", "Lab﻿Bom"],
    ["acentos", "Tecnoquímicas"],
  ];

  it.each(RAROS)("acepta y persiste un nombre con %s", async (_etiqueta, base) => {
    const name = `${base} ${RUN}`;

    const creado = await resolve(name);

    expect(creado.status).toBe("created");
    expect(creado.laboratory.name).toBe(name);
    expect(creado.laboratory.searchKey).not.toBe("");
  });

  it.each(RAROS)("reencuentra el mismo laboratorio con %s", async (_etiqueta, base) => {
    const name = `${base} ${RUN}`;

    const primero = await resolve(name);
    const segundo = await resolve(name);

    expect(segundo.status).toBe("exists");
    expect(segundo.laboratory.id).toBe(primero.laboratory.id);
    expect(await countNamed(RUN)).toBe(1);
  });

  it("la identidad es idempotente: normalizar lo ya normalizado no cambia nada", async () => {
    for (const [, base] of RAROS) {
      const [fila] = await prisma.$queryRaw<{ una: string; dos: string }[]>`
        SELECT laboratory_canonical_identity(${base}) AS una,
               laboratory_canonical_identity(laboratory_canonical_identity(${base})) AS dos
      `;
      expect(fila?.dos).toBe(fila?.una);
    }
  });

  // Hueco que ninguna de las dos implementaciones anteriores cubria: "é" en
  // un solo punto de codigo y "e" + acento combinante son el mismo nombre para
  // cualquier persona, y eran dos identidades distintas.
  it("NFC y NFD del mismo nombre son UN laboratorio", async () => {
    const precompuesto = `Café ${RUN}`;
    const descompuesto = `Café ${RUN}`;

    const primero = await resolve(precompuesto);
    const segundo = await resolve(descompuesto);

    expect(segundo.status).toBe("exists");
    expect(segundo.laboratory.id).toBe(primero.laboratory.id);
    expect(await countNamed(RUN)).toBe(1);
  });

  it("mayusculas acentuadas y minusculas son UN laboratorio", async () => {
    const primero = await resolve(`TECNOQUÍMICAS ${RUN}`);
    const segundo = await resolve(`Tecnoquímicas ${RUN}`);

    expect(segundo.status).toBe("exists");
    expect(segundo.laboratory.id).toBe(primero.laboratory.id);
    expect(await countNamed(RUN)).toBe(1);
  });

  it("searchKey lo escribe la BASE, no el llamador", async () => {
    const name = `Impuesto ${RUN}`;

    // El repositorio no manda `searchKey`; aunque alguien lo mandara, el
    // trigger lo pisa. Se prueba por la via cruda para que no dependa del
    // repositorio.
    await prisma.$executeRaw`
      INSERT INTO laboratories (id, name, "searchKey")
      VALUES (${`impuesto-${RUN}`}, ${name}, 'basura-que-no-corresponde')
    `;

    const fila = await prisma.laboratory.findUniqueOrThrow({ where: { name } });
    const [esperado] = await prisma.$queryRaw<{ v: string }[]>`
      SELECT laboratory_canonical_identity(${name}) AS v
    `;

    expect(fila.searchKey).toBe(esperado?.v);
    expect(fila.searchKey).not.toBe("basura-que-no-corresponde");
  });
});

// --------------------------------------------------------------------------
// La política elegida: BLOQUEAR.
//
// Si una base llega con identidades ya duplicadas, la migración FALLA y no
// avanza. No elige qué fila sobrevive, no borra y no reasigna relaciones —un
// `products.laboratoryId` movido por un algoritmo es evidencia perdida, y esa
// es una decisión de negocio, no de una migración.
//
// La guarda se lee del archivo de migración REAL en vez de copiarse acá, para
// que la prueba no pueda quedar verificando una versión vieja. Se ejecuta
// contra una tabla `laboratories` de mentira en su propio esquema, porque la
// de verdad ya no admite el estado que la guarda tiene que detectar.
// --------------------------------------------------------------------------
describe("identidad canónica · la migración bloquea en vez de elegir", () => {
  const MIGRACION = fileURLToPath(
    new URL(
      "../../prisma/migrations/20260828120000_add_laboratory_canonical_identity/migration.sql",
      import.meta.url,
    ),
  );

  function guardaDeLaMigracion(): string {
    const sql = readFileSync(MIGRACION, "utf8");
    const desde = sql.indexOf("DO $guard$");
    const hasta = sql.indexOf("$guard$;", desde);
    if (desde < 0 || hasta < 0) {
      throw new Error("No se encontró el bloque DO $guard$ en la migración");
    }
    return sql.slice(desde, hasta + "$guard$;".length);
  }

  async function conTablaFalsa(
    filas: string[],
    accion: () => Promise<void>,
  ): Promise<void> {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS guarda CASCADE`);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA guarda`);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE guarda.laboratories (name text NOT NULL)`,
    );
    for (const nombre of filas) {
      await prisma.$executeRaw`INSERT INTO guarda.laboratories (name) VALUES (${nombre})`;
    }
    try {
      await accion();
    } finally {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS guarda CASCADE`);
    }
  }

  async function correrGuarda(): Promise<void> {
    // `search_path` hace que la guarda vea la tabla falsa; la función canónica
    // se sigue resolviendo en `public`.
    await prisma.$executeRawUnsafe(
      `SET search_path TO guarda, public`,
    );
    try {
      await prisma.$executeRawUnsafe(guardaDeLaMigracion());
    } finally {
      await prisma.$executeRawUnsafe(`SET search_path TO public`);
    }
  }

  it("falla y nombra el grupo en conflicto", async () => {
    await conTablaFalsa(["Bayer", "bayer", "Genfar"], async () => {
      await expect(correrGuarda()).rejects.toThrow(/identidades canonicas duplicadas/i);
    });
  });

  it("el mensaje incluye los nombres para resolverlos a mano", async () => {
    await conTablaFalsa(["Lab  Doble", "Lab Doble"], async () => {
      await expect(correrGuarda()).rejects.toThrow(/Lab {2}Doble/);
    });
  });

  it("varias filas legacy que normalizan igual también bloquean", async () => {
    await conTablaFalsa(["MK", "mk", "  MK  ", "Mk"], async () => {
      await expect(correrGuarda()).rejects.toThrow(/identidades canonicas duplicadas/i);
    });
  });

  // El mensaje es lo unico que va a tener enfrente quien resuelva el bloqueo, y
  // `RAISE` de PL/pgSQL usa `%`, no `%s`: escribir `%s` deja una "s" suelta
  // pegada a cada valor. Se verifica entero, no por fragmentos.
  it("el mensaje de bloqueo se arma completo, sin sobras de formato", async () => {
    await conTablaFalsa(["Bayer", "bayer"], async () => {
      const error = await correrGuarda().then(
        () => null,
        (e: unknown) => e as { message: string; meta?: Record<string, unknown> },
      );

      expect(error).not.toBeNull();
      const mensaje = String(error?.message);

      expect(mensaje).toContain(
        "laboratories: hay identidades canonicas duplicadas, la migracion no continua:",
      );
      expect(mensaje).toContain("'bayer' <- 'Bayer', 'bayer'");

      // Las sobras que dejaba el `%s`: nunca una "s" pegada a los dos puntos ni
      // al valor, y ningun `%` sin sustituir.
      expect(mensaje).not.toContain("continua:s");
      expect(mensaje).not.toContain("'bayer's");
      expect(mensaje).not.toContain("%s");
      expect(mensaje).not.toMatch(/%[^A-Za-z0-9]/);
    });
  });

  it("el bloqueo revierte TODO: ni funcion ni trigger quedan a medias", async () => {
    // La funcion se crea antes de la guarda. Si la migracion no corriera en una
    // transaccion, un bloqueo dejaria la base a medio migrar.
    await conTablaFalsa(["MK", "mk"], async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO guarda, public`);
          await tx.$executeRawUnsafe(
            `CREATE TABLE guarda.marca_de_migracion (id int)`,
          );
          await tx.$executeRawUnsafe(guardaDeLaMigracion());
        }),
      ).rejects.toThrow(/identidades canonicas duplicadas/i);

      const marcas = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_tables
         WHERE schemaname = 'guarda' AND tablename = 'marca_de_migracion'
      `;
      expect(Number(marcas[0]?.n)).toBe(0);
    });
  });

  it("sin colisiones, la guarda deja pasar", async () => {
    await conTablaFalsa(["Bayer", "Genfar", "MK Pharma"], async () => {
      await expect(correrGuarda()).resolves.toBeUndefined();
    });
  });
});

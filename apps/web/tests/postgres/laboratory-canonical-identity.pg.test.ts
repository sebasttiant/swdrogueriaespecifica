import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  laboratoryCreateCommandKey,
  normalizeLaboratoryName,
} from "@/server/domain/laboratory/identity";
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
      prisma.laboratory.create({
        data: {
          name: name.toUpperCase(),
          searchKey: normalizeLaboratoryName(name.toUpperCase()),
        },
      }),
    ).rejects.toThrow();

    expect(await countNamed(RUN)).toBe(1);
  });

  it("un searchKey que no deriva del nombre es rechazado por el CHECK", async () => {
    await expect(
      prisma.laboratory.create({
        data: { name: `Torcido ${RUN}`, searchKey: "otra-cosa" },
      }),
    ).rejects.toThrow();

    expect(await countNamed(RUN)).toBe(0);
  });

  it("el índice funcional y el CHECK existen en el catálogo", async () => {
    const indices = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'laboratories'
         AND indexname = 'laboratories_canonical_identity_key'
    `;
    expect(indices).toHaveLength(1);

    const checks = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'laboratories'::regclass
         AND conname = 'laboratories_searchKey_canonical_check'
    `;
    expect(checks).toHaveLength(1);
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
// El contrato entre las dos implementaciones de la MISMA regla.
//
// `normalizeLaboratoryName` vive en TypeScript y `laboratory_canonical_identity`
// en PostgreSQL. Si se separan, una identidad duplicada se cuela por la
// diferencia. La clase de blancos de `\s` en JavaScript es más ancha que la de
// PostgreSQL, y esa fue exactamente la trampa: la migración le suma a mano los
// blancos Unicode que le faltaban.
// --------------------------------------------------------------------------
describe("identidad canónica · JS y SQL calculan lo mismo", () => {
  const CASOS = [
    "Bayer",
    "  Bayer  ",
    "BAYER",
    "Lab  Doble",
    "Lab\tTab",
    "Lab\nSalto",
    "Lab\r\nCRLF",
    "LabVertical",
    "Lab\fFormFeed",
    "Bayer S.A.",
    "  MK   Pharma  ",
    "Lab NBSP",
    "Lab EmSpace",
    "Lab　Ideografico",
    "Lab SeparadorLinea",
    "Lab Matematico",
    "Lab﻿BOM",
    " Bayer ",
    "lab-x_1",
    "Genfar 100% Natural",
  ];

  it.each(CASOS)("coinciden para %j", async (caso) => {
    const [fila] = await prisma.$queryRaw<{ sql: string }[]>`
      SELECT laboratory_canonical_identity(${caso}) AS sql
    `;

    expect(fila?.sql).toBe(normalizeLaboratoryName(caso));
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

  it("sin colisiones, la guarda deja pasar", async () => {
    await conTablaFalsa(["Bayer", "Genfar", "MK Pharma"], async () => {
      await expect(correrGuarda()).resolves.toBeUndefined();
    });
  });
});

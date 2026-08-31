import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  findIdentityConflicts,
  formatConflictReport,
  temporaryIdentityFunctionSql,
} from "@/prisma/laboratory-identity-preflight";

// --------------------------------------------------------------------------
// El preflight que evita que el despliegue se entere tarde.
//
// La migración de identidad canónica aborta si la base ya trae duplicados. El
// preflight tiene que decir eso ANTES, sin escribir nada.
//
// Va contra PostgreSQL real y no contra un mock por la misma razón que la
// migración: la regla la calcula la base —plegado de mayúsculas, NFC, clases
// de blancos Unicode—, y ninguna de esas cosas se puede simular desde
// TypeScript. Un mock probaría la simulación, no la regla.
//
// El caso "con duplicados" se ejerce sobre una tabla `laboratories` de mentira
// en su propio esquema, porque la de verdad ya está migrada y su índice único
// no admite el estado que hay que detectar. Es la misma técnica que usa
// `laboratory-canonical-identity.pg.test.ts` para probar la guarda.
// --------------------------------------------------------------------------

const APP_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url));

async function conTablaFalsa<T>(
  filas: { id: string; name: string }[],
  accion: () => Promise<T>,
): Promise<T> {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS preflight CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA preflight`);
  await prisma.$executeRawUnsafe(
    `CREATE TABLE preflight.laboratories (id text PRIMARY KEY, name text NOT NULL)`,
  );
  for (const fila of filas) {
    await prisma.$executeRaw`
      INSERT INTO preflight.laboratories (id, name) VALUES (${fila.id}, ${fila.name})
    `;
  }
  try {
    return await accion();
  } finally {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS preflight CASCADE`);
  }
}

/** Corre el preflight viendo la tabla falsa en vez de la real. */
async function preflightSobreLaFalsa() {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO preflight, public`);
    return findIdentityConflicts(tx);
  });
}

describe("preflight de identidad · base limpia", () => {
  it("la tabla real, ya migrada, no tiene conflictos", async () => {
    const conflictos = await prisma.$transaction((tx) =>
      findIdentityConflicts(tx),
    );

    expect(conflictos).toEqual([]);
  });

  it("nombres distintos no son un conflicto", async () => {
    const conflictos = await conTablaFalsa(
      [
        { id: "l1", name: "Bayer" },
        { id: "l2", name: "Genfar" },
        { id: "l3", name: "MK Pharma" },
      ],
      preflightSobreLaFalsa,
    );

    expect(conflictos).toEqual([]);
  });

  it("una tabla vacía tampoco", async () => {
    const conflictos = await conTablaFalsa([], preflightSobreLaFalsa);

    expect(conflictos).toEqual([]);
  });
});

describe("preflight de identidad · la base trae duplicados", () => {
  it("detecta la diferencia de mayúsculas y nombra las dos filas", async () => {
    const conflictos = await conTablaFalsa(
      [
        { id: "l1", name: "Bayer" },
        { id: "l2", name: "bayer" },
        { id: "l3", name: "Genfar" },
      ],
      preflightSobreLaFalsa,
    );

    expect(conflictos).toHaveLength(1);
    expect(conflictos[0]?.identity).toBe("bayer");
    expect(conflictos[0]?.names).toEqual(["Bayer", "bayer"]);
    expect(conflictos[0]?.ids).toEqual(["l1", "l2"]);
  });

  it("detecta el espacio interno de más", async () => {
    const conflictos = await conTablaFalsa(
      [
        { id: "l1", name: "Lab  Doble" },
        { id: "l2", name: "Lab Doble" },
      ],
      preflightSobreLaFalsa,
    );

    expect(conflictos).toHaveLength(1);
    expect(conflictos[0]?.names).toEqual(["Lab  Doble", "Lab Doble"]);
  });

  it("detecta los blancos Unicode que `[[:space:]]` no cubre", async () => {
    const conflictos = await conTablaFalsa(
      [
        { id: "l1", name: "Lab NBSP" },
        { id: "l2", name: "Lab NBSP" },
      ],
      preflightSobreLaFalsa,
    );

    expect(conflictos).toHaveLength(1);
    // Ordenado acá y no en la aserción de orden: estos dos nombres difieren
    // SOLO en un carácter invisible, y cuál va primero lo decide la colación
    // del servidor. Lo que el preflight tiene que garantizar es que informe
    // las dos filas, no en qué orden las lista.
    expect([...(conflictos[0]?.ids ?? [])].sort()).toEqual(["l1", "l2"]);
  });

  it("detecta NFC contra NFD, que los índices viejos no veían", async () => {
    const conflictos = await conTablaFalsa(
      [
        { id: "l1", name: "Café" },
        { id: "l2", name: "Café" },
      ],
      preflightSobreLaFalsa,
    );

    expect(conflictos).toHaveLength(1);
    // Mismo motivo que arriba: 'é' precompuesto y descompuesto se ordenan
    // según la colación, no según el preflight.
    expect([...(conflictos[0]?.ids ?? [])].sort()).toEqual(["l1", "l2"]);
  });

  it("informa cada grupo por separado, ordenado", async () => {
    const conflictos = await conTablaFalsa(
      [
        { id: "l1", name: "MK" },
        { id: "l2", name: "mk" },
        { id: "l3", name: "Bayer" },
        { id: "l4", name: "BAYER" },
        { id: "l5", name: "Genfar" },
      ],
      preflightSobreLaFalsa,
    );

    expect(conflictos.map((c) => c.identity)).toEqual(["bayer", "mk"]);
  });

  it("no escribe nada: las filas quedan como estaban", async () => {
    await conTablaFalsa(
      [
        { id: "l1", name: "Bayer" },
        { id: "l2", name: "bayer" },
      ],
      async () => {
        await preflightSobreLaFalsa();

        const filas = await prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
          `SELECT id, name FROM preflight.laboratories ORDER BY id`,
        );
        expect(filas).toEqual([
          { id: "l1", name: "Bayer" },
          { id: "l2", name: "bayer" },
        ]);
      },
    );
  });

  it("es idempotente: dos corridas seguidas dan el mismo resultado", async () => {
    await conTablaFalsa(
      [
        { id: "l1", name: "Bayer" },
        { id: "l2", name: "bayer" },
      ],
      async () => {
        const primera = await preflightSobreLaFalsa();
        const segunda = await preflightSobreLaFalsa();
        expect(segunda).toEqual(primera);
      },
    );
  });
});

// --------------------------------------------------------------------------
// La regla es UNA sola.
//
// El preflight corre ANTES de la migración, así que no puede llamar a
// `laboratory_canonical_identity()`: todavía no existe. Instala la definición
// del archivo de migración en `pg_temp`. Esta prueba es la que impide que las
// dos se separen: si alguien edita la migración, las dos cambian juntas o esto
// se pone rojo.
// --------------------------------------------------------------------------
describe("preflight de identidad · una sola definición de la regla", () => {
  const RAROS = [
    "Bayer",
    "bayer",
    "Lab  Doble",
    "Lab NBSP",
    "Lab　Ideo",
    "Lab﻿Bom",
    "Café",
    "Café",
    "TECNOQUÍMICAS",
    "ΟΣ",
    "İstanbul",
    "  espacios  alrededor  ",
  ];

  it("la función temporal da lo mismo que la definitiva, nombre por nombre", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(temporaryIdentityFunctionSql());

      for (const nombre of RAROS) {
        const [fila] = await tx.$queryRaw<{ temporal: string; real: string }[]>`
          SELECT pg_temp.laboratory_canonical_identity(${nombre}) AS temporal,
                 laboratory_canonical_identity(${nombre})         AS real
        `;
        expect(fila?.temporal, `identidad de ${JSON.stringify(nombre)}`).toBe(
          fila?.real,
        );
      }
    });
  });

  it("la extracción falla ruidosamente si la migración deja de definirla", () => {
    expect(() => temporaryIdentityFunctionSql("-- migración sin la función")).toThrow(
      /No se encontró la definición/,
    );
  });
});

describe("preflight de identidad · el informe para quien lo resuelve", () => {
  const CONFLICTO = {
    identity: "bayer",
    names: ["Bayer", "bayer"],
    ids: ["l1", "l2"],
  };

  it("nombra la identidad, los nombres y los ids", () => {
    const informe = formatConflictReport([CONFLICTO]);

    expect(informe).toContain('"bayer"');
    expect(informe).toContain("id: l1");
    expect(informe).toContain("id: l2");
    expect(informe).toContain("20260828120000_add_laboratory_canonical_identity");
  });

  it("dice explícitamente que no resuelve nada por su cuenta", () => {
    expect(formatConflictReport([CONFLICTO])).toMatch(
      /no eligen, borran o reasignan|Ni este chequeo ni la migración eligen/,
    );
  });

  it("hace visibles los blancos del nombre, que a ojo no se distinguen", () => {
    const informe = formatConflictReport([
      { identity: "lab doble", names: ["Lab  Doble", "Lab Doble"], ids: ["a", "b"] },
    ]);

    // Con comillas JSON, "Lab  Doble" y "Lab Doble" se distinguen en pantalla.
    expect(informe).toContain('"Lab  Doble"');
    expect(informe).toContain('"Lab Doble"');
  });
});

// --------------------------------------------------------------------------
// El guion de verdad, ejecutado como lo va a ejecutar el despliegue.
//
// Los tests de arriba prueban la lógica; este prueba que el ARCHIVO arranque:
// que sus importaciones resuelvan fuera de vitest, que el `await` de nivel
// superior funcione bajo tsx, y que el código de salida sea el que `deploy.sh`
// va a leer. Un preflight que no arranca es peor que no tenerlo.
// --------------------------------------------------------------------------
describe("preflight de identidad · el guion ejecutable", () => {
  function correr(
    env: Record<string, string | undefined>,
  ): { status: number; salida: string } {
    try {
      const salida = execFileSync(
        "pnpm",
        ["exec", "tsx", "prisma/preflight-laboratory-identity.ts"],
        { cwd: APP_DIRECTORY, env: { ...process.env, ...env }, encoding: "utf8", stdio: "pipe" },
      );
      return { status: 0, salida };
    } catch (error) {
      const fallo = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: fallo.status ?? -1,
        salida: `${fallo.stdout ?? ""}${fallo.stderr ?? ""}`,
      };
    }
  }

  it("sale 0 contra una base sin conflictos", () => {
    const { status, salida } = correr({ DATABASE_URL: process.env.DATABASE_URL });

    expect(salida).toContain("OK: no hay identidades canónicas duplicadas");
    expect(status).toBe(0);
  });

  it("sale 2 y no revienta cuando no hay DATABASE_URL", () => {
    const { status, salida } = correr({ DATABASE_URL: "" });

    expect(status).toBe(2);
    expect(salida).toContain("falta DATABASE_URL");
  });

  it("sale 2 sin filtrar la URL de conexión cuando la base no responde", () => {
    const inalcanzable = "postgresql://usuario:sup3rs3cr3t@127.0.0.1:1/nada";

    const { status, salida } = correr({ DATABASE_URL: inalcanzable });

    expect(status).toBe(2);
    expect(salida).not.toContain("sup3rs3cr3t");
    expect(salida).toContain("no se pudo verificar");
  });
});

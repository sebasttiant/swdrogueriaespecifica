import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { checkReadiness } from "@/lib/health/readiness";

// --------------------------------------------------------------------------
// Readiness contra PostgreSQL de verdad.
//
// Los tests con mock fijan qué se responde ante un fallo; ninguno prueba lo
// único que el endpoint promete: que la sonda FUNCIONA contra un PostgreSQL
// real. Un `SELECT 1` que el mock acepta pero que el driver rechaza dejaría el
// readiness devolviendo 503 con la base perfectamente sana — y nadie lo sabría
// hasta el despliegue.
// --------------------------------------------------------------------------

describe("readiness · contra una base real", () => {
  it("la sonda corre y dice que está lista", async () => {
    const resultado = await checkReadiness(() => prisma.$queryRaw`SELECT 1`);

    expect(resultado).toEqual({ ready: true });
  });

  it("es repetible: consultarla no cambia nada", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(await checkReadiness(() => prisma.$queryRaw`SELECT 1`)).toEqual({
        ready: true,
      });
    }
  });

  it("no necesita ninguna tabla: sirve durante una migración", async () => {
    // Se corre en un esquema vacío para probar que la sonda no depende del
    // esquema de la aplicación.
    await prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS readiness_vacio CASCADE");
    await prisma.$executeRawUnsafe("CREATE SCHEMA readiness_vacio");
    try {
      const resultado = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL search_path TO readiness_vacio");
        return checkReadiness(() => tx.$queryRaw`SELECT 1`);
      });

      expect(resultado).toEqual({ ready: true });
    } finally {
      await prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS readiness_vacio CASCADE");
    }
  });

  // El caso que justifica el endpoint: la web está viva y la base no se
  // alcanza. Se prueba con una URL que no responde, no rompiendo la de verdad.
  it("una base inalcanzable da 'unavailable', no una excepción", async () => {
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { PrismaClient } = await import("@/lib/generated/prisma/client");

    const cliente = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: "postgresql://nadie:nada@127.0.0.1:1/inexistente",
        max: 1,
        connectionTimeoutMillis: 1_000,
      }),
    });

    try {
      const resultado = await checkReadiness(() => cliente.$queryRaw`SELECT 1`, {
        timeoutMs: 4_000,
      });

      expect(resultado.ready).toBe(false);
      // No se afirma la categoría: según cómo falle la conexión puede ser un
      // rechazo ("unavailable") o no volver a tiempo ("timeout"). Lo que el
      // endpoint promete es que NO está lista y que no explota.
      expect(JSON.stringify(resultado)).not.toContain("127.0.0.1");
    } finally {
      await cliente.$disconnect();
    }
  });
});

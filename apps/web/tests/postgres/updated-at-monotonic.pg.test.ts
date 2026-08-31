import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";

// --------------------------------------------------------------------------
// ¿Puede `updatedAt` repetirse entre dos escrituras seguidas?
//
// La revisión plantea que sí —`TIMESTAMP(3)` tiene resolución de milisegundo—
// y que por eso comparar versiones con `>` puede concluir que las props ya
// alcanzaron al eco cuando todavía no. Antes de cambiar código por esa
// hipótesis, se mide contra PostgreSQL real: si dos escrituras consecutivas
// nunca colisionan, el escenario no existe y no hay nada que corregir.
// --------------------------------------------------------------------------

const sufijo = randomUUID().slice(0, 8);

afterAll(async () => {
  await prisma.product.deleteMany({ where: { code: { contains: sufijo } } });
});

describe("updatedAt · resolución y colisiones", () => {
  it("mide cuántas escrituras seguidas comparten el mismo updatedAt", async () => {
    const product = await prisma.product.create({
      data: { code: `MONO-${sufijo}`, name: "Sonda", unit: "unidad" },
    });

    const versiones: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const row = await prisma.product.update({
        where: { id: product.id },
        data: { minStock: i },
      });
      versiones.push(row.updatedAt.getTime());
    }

    const colisiones = versiones.filter((v, i) => i > 0 && v === versiones[i - 1]!).length;
    const retrocesos = versiones.filter((v, i) => i > 0 && v < versiones[i - 1]!).length;

    console.log(
      `[updatedAt] 40 escrituras: ${colisiones} colisiones consecutivas, ${retrocesos} retrocesos`,
    );

    // No se afirma un resultado: esta prueba MIDE. Lo que fija es que la
    // secuencia nunca RETROCEDA, que es lo único que rompería una comparación
    // por orden más allá de la igualdad.
    expect(retrocesos).toBe(0);
  });

  it("dos escrituras dentro de la misma transacción, lo más rápido posible", async () => {
    const product = await prisma.product.create({
      data: { code: `MONO2-${sufijo}`, name: "Sonda 2", unit: "unidad" },
    });

    const [a, b] = await prisma.$transaction([
      prisma.product.update({ where: { id: product.id }, data: { minStock: 1 } }),
      prisma.product.update({ where: { id: product.id }, data: { minStock: 2 } }),
    ]);

    console.log(
      `[updatedAt] misma transacción: a=${a.updatedAt.toISOString()} b=${b.updatedAt.toISOString()} iguales=${a.updatedAt.getTime() === b.updatedAt.getTime()}`,
    );

    expect(b.updatedAt.getTime()).toBeGreaterThanOrEqual(a.updatedAt.getTime());
  });
});

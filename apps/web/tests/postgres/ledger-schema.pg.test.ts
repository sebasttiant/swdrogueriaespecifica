import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";

// Las garantías del ledger no son de código: son del esquema. Este archivo las
// lee de PostgreSQL, del catálogo real, no del schema de Prisma — porque lo
// que protege la historia en producción es el constraint, no el DSL.
//
// Si alguien afloja uno de estos constraints en una migración futura, acá se
// entera antes de mergear.

async function constraintDef(table: string, name: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<{ def: string }[]>(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = '${table}'::regclass AND conname = '${name}'`,
  );
  return rows[0]?.def ?? null;
}

describe("esquema del ledger de movimientos", () => {
  // LA regla del slice: el ledger se retiene de forma permanente (D4). El
  // CASCADE de `lots.productId` NO se hereda acá. Un ledger que un DELETE
  // puede borrar no es un ledger.
  it("la clave foránea al lote es RESTRICT, no CASCADE", async () => {
    const def = await constraintDef("inventory_movements", "inventory_movements_lotId_fkey");

    expect(def).toContain("ON DELETE RESTRICT");
    expect(def).not.toContain("ON DELETE CASCADE");
  });

  it("la clave foránea al comando también es RESTRICT", async () => {
    const def = await constraintDef(
      "inventory_movements",
      "inventory_movements_commandId_fkey",
    );

    expect(def).toContain("ON DELETE RESTRICT");
  });

  // Un comando asienta una vez. Sin esto, un reintento que llegara al INSERT
  // duplicaría el movimiento y el stock quedaría mal para siempre.
  it("un comando no puede tener dos asientos", async () => {
    const rows = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'inventory_movements'
          AND indexname = 'inventory_movements_commandId_key'`,
    );

    expect(rows[0]?.indexdef).toContain("UNIQUE");
  });

  // El asiento no se edita: la tabla ni siquiera tiene dónde anotar que se
  // editó. La inmutabilidad empieza por no tener la columna.
  it("la tabla de movimientos no tiene columna de actualización", async () => {
    const rows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'inventory_movements' AND column_name = 'updatedAt'`,
    );

    expect(rows).toEqual([]);
  });

  it("el comando tiene que terminar con resultado o con error", async () => {
    const def = await constraintDef(
      "operational_commands",
      "operational_commands_outcome_present",
    );

    expect(def).toContain("CHECK");
  });

  // El actor es parte de la identidad del comando: sin él, otro usuario podría
  // reclamar el resultado de una operación que no ejecutó.
  it("la identidad del comando incluye al actor", async () => {
    const rows = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'operational_commands'
          AND indexname = 'operational_commands_actorId_commandType_commandKey_key'`,
    );

    expect(rows[0]?.indexdef).toContain("UNIQUE");
    expect(rows[0]?.indexdef).toContain("actorId");
  });

  it("no toca el modelo legado de lotes", async () => {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) AS count FROM information_schema.columns
        WHERE table_name = 'product_batches'`,
    );

    expect(Number(rows[0]?.count)).toBe(9);
  });
});

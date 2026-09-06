import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { expect, it } from "vitest";

import { PrismaClient } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db/prisma";

const APP = process.cwd();
const MIGRATIONS = resolve(APP, "prisma/migrations");
const TARGET = "20260901210000_add_inventory_cutover_marker";

function execute(url: string, args: string[], input?: string): void {
  execFileSync("pnpm", ["exec", "prisma", "db", "execute", ...args], {
    cwd: APP, env: { ...process.env, DATABASE_URL: url }, input, stdio: ["pipe", "pipe", "pipe"],
  });
}

it("upgrades existing beta inventory before installing false defaults", async () => {
  const name = `drogueria_upgrade_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });

  try {
    // ANTES del cutover, no "todas menos el cutover". Los nombres empiezan con
    // su marca de tiempo, así que el orden lexicográfico ES el cronológico.
    //
    // El filtro decía `!== TARGET`, y mientras el cutover fue la última
    // migración las dos formas daban el mismo conjunto. Dejó de darlo apenas
    // entró una migración posterior: esa se colaba en el replay "previo" y el
    // conteo saltaba, cuando en realidad no tiene nada que ver con probar que
    // el cutover actualiza las filas viejas. El número de abajo es un guardián
    // de ESE conjunto, y solo debe moverse cuando alguien agregue una migración
    // anterior al cutover —cosa que casi nunca pasa—.
    const previous = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name < TARGET).map((entry) => entry.name).sort();
    expect(previous).toHaveLength(47);
    execute(url.toString(), ["--stdin"], previous.map((migration) =>
      readFileSync(resolve(MIGRATIONS, migration, "migration.sql"), "utf8")).join("\n"));

    execute(url.toString(), ["--stdin"], `
      INSERT INTO users (id,email,name,"updatedAt") VALUES ('u','upgrade@test.invalid','Upgrade',now());
      INSERT INTO products (id,code,name,unit,"updatedAt") VALUES ('p','UPGRADE','Upgrade','unit',now());
      INSERT INTO pendings (id,"productId",quantity,"promisedAt","updatedAt") VALUES ('pd','p',1,now(),now());
      INSERT INTO missing_items (id,"productId",quantity,"updatedAt") VALUES ('mi','p',1,now());
      INSERT INTO product_batches (id,"productId","batchCode","expiresAt",quantity,"updatedAt") VALUES ('pb','p','UP',now(),1,now());
      INSERT INTO inventory_entries (id,"productId",quantity,"idempotencyKey","requestFingerprint") VALUES ('ie','p',1,'00000000-0000-4000-8000-000000000249','up');
      INSERT INTO inventory_allocations (id,"inventoryEntryId","missingItemId",quantity) VALUES ('ia','ie','mi',1);
      INSERT INTO pending_inventory_reservations (id,"pendingId","batchId",quantity) VALUES ('pr','pd','pb',1);`);

    execute(url.toString(), ["--file", resolve(MIGRATIONS, TARGET, "migration.sql")]);
    execute(url.toString(), ["--stdin"], `
      INSERT INTO pendings (id,"productId",quantity,"promisedAt","updatedAt") VALUES ('pd-new','p',1,now(),now());
      INSERT INTO missing_items (id,"productId",quantity,"updatedAt") VALUES ('mi-new','p',1,now());`);
    const [evidence] = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT id, state::text, count(*) OVER ()::int AS "singletonCount", "pendingMarkedCount", "missingItemMarkedCount",
        "productBatchPreservedCount", "inventoryEntryPreservedCount", "inventoryAllocationPreservedCount", "pendingReservationPreservedCount",
        (SELECT "legacyBeta" FROM pendings WHERE id='pd') AS "pendingOld", (SELECT "legacyBeta" FROM missing_items WHERE id='mi') AS "missingOld",
        (SELECT "legacyBeta" FROM pendings WHERE id='pd-new') AS "pendingNew", (SELECT "legacyBeta" FROM missing_items WHERE id='mi-new') AS "missingNew"
      FROM inventory_cutovers`);
    expect(evidence).toEqual({ id: 1, state: "PREPARED", singletonCount: 1, pendingMarkedCount: 1, missingItemMarkedCount: 1,
      productBatchPreservedCount: 1, inventoryEntryPreservedCount: 1, inventoryAllocationPreservedCount: 1,
      pendingReservationPreservedCount: 1, pendingOld: true, missingOld: true, pendingNew: false, missingNew: false });
  } finally {
    await client.$disconnect();
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
});

/**
 * Audited repair of duplicated product identity — DRY-RUN BY DEFAULT.
 *
 * Reads a manifest written by whoever investigated the incident, checks that
 * the database still looks the way the manifest says, prints the plan, and
 * writes NOTHING unless `--apply` is passed.
 *
 *   DATABASE_URL=postgresql://... AUTH_SECRET=... \
 *     pnpm --filter @drogueria/web db:repair:identidad -- --manifest=./repair.json
 *
 * Add `--apply` only after reviewing the dry-run output against a RESTORED
 * copy of the database you intend to repair. Exit code 1 means blocked or
 * nothing was applied, so a runbook can chain on it.
 *
 * Manifest shape (every field is required except `apply`):
 *
 *   {
 *     "actorId": "<user id running the repair>",
 *     "targetProductId": "<product that keeps the stock>",
 *     "expectedTargetOrionCode": "<code the product has right now, or null>",
 *     "canonicalOrionCode": "<the exact code Orion shows>",
 *     "duplicateProductIds": ["<product to deactivate>"],
 *     "pendingIds": ["<pending to move onto the target>"],
 *     "missingItemIds": ["<missing item to move onto the target>"]
 *   }
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { prisma } from "@/lib/db/prisma";
import {
  formatRepairReport,
  repairProductIdentity,
  type ProductIdentityRepairManifest,
} from "@/server/services/product-identity-repair.service";

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const flag = process.argv.find((arg) => arg.startsWith(prefix));
  return flag ? flag.slice(prefix.length) : undefined;
}

function readManifest(): ProductIdentityRepairManifest {
  const path = readFlag("manifest");
  if (!path) {
    throw new Error("Falta --manifest=<ruta>. El manifiesto es lo que se revisa antes de aplicar.");
  }

  let parsed: ProductIdentityRepairManifest;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as ProductIdentityRepairManifest;
  } catch (error) {
    throw new Error(
      `No se pudo leer el manifiesto "${path}": ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The manifest comes from a human. Validating its SHAPE here means a typo
  // fails before touching the database, not halfway through the repair.
  const required = [
    "actorId",
    "targetProductId",
    "canonicalOrionCode",
  ] as const;
  for (const field of required) {
    if (typeof parsed[field] !== "string" || parsed[field].length === 0) {
      throw new Error(`El manifiesto necesita "${field}" como texto no vacío.`);
    }
  }
  if (!("expectedTargetOrionCode" in parsed)) {
    throw new Error(
      'El manifiesto necesita "expectedTargetOrionCode" (puede ser null): es la guarda de drift.',
    );
  }
  for (const field of ["duplicateProductIds", "pendingIds", "missingItemIds"] as const) {
    if (!Array.isArray(parsed[field])) {
      throw new Error(`El manifiesto necesita "${field}" como lista (puede estar vacía).`);
    }
  }

  // `apply` NEVER comes from the file: it is a decision taken at the command
  // line, in front of the database, not something a committed file can carry.
  return { ...parsed, apply: process.argv.includes("--apply") };
}

async function main(): Promise<boolean> {
  const manifest = readManifest();
  const report = await repairProductIdentity(manifest);

  console.log(formatRepairReport(report, { applyRequested: manifest.apply === true }));

  if (report.status === "blocked") {
    console.log(
      "\nLa base no coincide con el manifiesto revisado. Volvé a investigar y\n" +
        "regenerá el manifiesto: reparar una base que ya no reconocés es cómo\n" +
        "un incidente se convierte en dos.",
    );
  }

  return report.status === "applied" || report.status === "noop";
}

main()
  .then(async (ok) => {
    await prisma.$disconnect();
    process.exit(ok ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    // Si el fallo ocurrió antes de crear Prisma (por ejemplo, manifiesto
    // inválido), desconectar no debe tapar el error original con otro fallo de
    // validación de entorno.
    try {
      await prisma.$disconnect();
    } catch {
      // El error original ya fue impreso y es el que guía la operación.
    }
    process.exit(1);
  });

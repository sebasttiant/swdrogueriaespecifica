import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { prisma } from "@/lib/db/prisma";
import {
  formatPendingProductRepairReport,
  repairPendingProduct,
  type PendingProductRepairManifest,
} from "@/server/services/pending-product-repair.service";

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function readManifest(): PendingProductRepairManifest {
  const path = flagValue("manifest");
  if (!path) throw new Error("Falta --manifest=<ruta>.");

  let parsed: PendingProductRepairManifest;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as PendingProductRepairManifest;
  } catch (error) {
    throw new Error(
      `No se pudo leer el manifiesto "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const requiredStrings = [
    "repairId",
    "actorEmail",
    "pendingId",
    "expectedCurrentProductId",
    "expectedCurrentProductName",
    "targetProductId",
    "expectedStatus",
    "expectedPurchaseStatus",
    "expectedAvailabilityStatus",
    "expectedCustomerStatus",
    "expectedTargetName",
    "expectedTargetOrionCode",
    "reason",
  ] as const;
  for (const field of requiredStrings) {
    if (typeof parsed[field] !== "string" || parsed[field].trim().length === 0) {
      throw new Error(`El manifiesto necesita "${field}" como texto no vacío.`);
    }
  }
  if (!("expectedCurrentProductOrionCode" in parsed)) {
    throw new Error(
      'El manifiesto necesita "expectedCurrentProductOrionCode" (puede ser null).',
    );
  }
  if (
    parsed.expectedCurrentProductOrionCode !== null &&
    typeof parsed.expectedCurrentProductOrionCode !== "string"
  ) {
    throw new Error('"expectedCurrentProductOrionCode" debe ser texto o null.');
  }
  if (!Number.isInteger(parsed.expectedQuantity) || parsed.expectedQuantity <= 0) {
    throw new Error('El manifiesto necesita "expectedQuantity" como entero positivo.');
  }
  if (parsed.expectedCurrentProductId === parsed.targetProductId) {
    throw new Error("El producto actual y el objetivo deben ser distintos.");
  }

  return { ...parsed, apply: process.argv.includes("--apply") };
}

async function main(): Promise<boolean> {
  const manifest = readManifest();
  const repair = await repairPendingProduct(manifest);
  console.log(formatPendingProductRepairReport(repair));
  return repair.status === "applied" || repair.status === "noop";
}

main()
  .then(async (ok) => {
    await prisma.$disconnect();
    process.exit(ok ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    try {
      await prisma.$disconnect();
    } catch {
      // Preserve the original operational error.
    }
    process.exit(1);
  });

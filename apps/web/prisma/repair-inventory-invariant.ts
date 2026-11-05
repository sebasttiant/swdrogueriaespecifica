/**
 * One-time #332 repair: physical-total batches and real reservations.
 * DRY-RUN BY DEFAULT.
 *
 *   docker compose run --rm --no-deps repair-invariant --actor=<user id>
 *   docker compose run --rm --no-deps repair-invariant --actor=<user id> \
 *     --apply --expect=<fingerprint printed by the dry-run>
 *
 * The dry-run executes the whole repair inside a transaction and rolls it
 * back, so the fingerprint it prints describes exactly what apply writes.
 * Apply refuses any other fingerprint. Exit code 1 means blocked or failed.
 */
import { prisma } from "@/lib/db/prisma";
import {
  formatInventoryInvariantReport,
  repairInventoryInvariant,
} from "@/server/services/inventory-invariant-repair.service";

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const flag = process.argv.find((arg) => arg.startsWith(prefix));
  return flag ? flag.slice(prefix.length) : undefined;
}

async function main(): Promise<boolean> {
  const actorId = readFlag("actor");
  if (!actorId) throw new Error("Falta --actor=<user id>.");
  const apply = process.argv.includes("--apply");
  if (!apply) console.log("==> DRY-RUN: se simula todo y se revierte; no se escribe nada.");

  const report = await repairInventoryInvariant({
    actorId,
    apply,
    expectedFingerprint: readFlag("expect"),
  });
  console.log(formatInventoryInvariantReport(report));
  return report.status !== "blocked";
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
      // The original error was already printed.
    }
    process.exit(1);
  });

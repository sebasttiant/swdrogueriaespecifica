/**
 * WINDOW 3 — fusiona productos con el mismo número de Orión escrito distinto.
 *
 *   docker compose run --rm --no-deps repair-merges --actor=<user id>
 *
 * Sin `--apply` no escribe nada. Revisá merges vs bloqueados antes de aplicar.
 */
import { prisma } from "@/lib/db/prisma";
import {
  formatOrionMergeReport,
  mergeOrionConflicts,
} from "@/server/services/orion-conflict-merge.service";

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const flag = process.argv.find((arg) => arg.startsWith(prefix));
  return flag ? flag.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const actorId = readFlag("actor");
  if (!actorId) {
    throw new Error("Falta --actor=<user id>. Es el SUPERADMIN que queda en la auditoría.");
  }
  const apply = process.argv.includes("--apply");

  const report = await mergeOrionConflicts({ actorId, apply });
  console.log(formatOrionMergeReport(report));
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    try {
      await prisma.$disconnect();
    } catch {
      // El error original ya se imprimió.
    }
    process.exit(1);
  });

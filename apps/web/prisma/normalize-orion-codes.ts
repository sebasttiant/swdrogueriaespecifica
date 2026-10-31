/**
 * Lleva los códigos de Orión ya cargados a su forma canónica — DRY-RUN POR
 * DEFECTO.
 *
 *   docker compose run --rm --no-deps repair-codes --actor=<user id>
 *
 * Local:
 *   pnpm --filter @drogueria/web db:normalize:orion -- --actor=<user id>
 *
 * Sin `--apply` no escribe nada: imprime CADA renombre y CADA conflicto, que es
 * lo que hay que leer antes de ejecutar. Los conflictos —dos o más productos
 * peleando el mismo número de Orión— quedan intactos a propósito: decidir cuál
 * sobrevive exige mirar su stock y sus pendientes, y eso lo hace una persona
 * con `db:repair:identidad`.
 *
 * Código de salida 1 cuando no se aplicó nada, para poder encadenarlo en un
 * runbook.
 */
import { prisma } from "@/lib/db/prisma";
import {
  formatNormalizationReport,
  normalizeOrionCodes,
} from "@/server/services/orion-code-normalization.service";

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const flag = process.argv.find((arg) => arg.startsWith(prefix));
  return flag ? flag.slice(prefix.length) : undefined;
}

async function main(): Promise<boolean> {
  const actorId = readFlag("actor");
  if (!actorId) {
    throw new Error(
      "Falta --actor=<user id>. Cada renombre queda firmado: sin responsable no se ejecuta.",
    );
  }

  const apply = process.argv.includes("--apply");
  const report = await normalizeOrionCodes({ apply, actorId });
  console.log(formatNormalizationReport(report));

  return report.applied;
}

main()
  .then(async (applied) => {
    await prisma.$disconnect();
    process.exit(applied ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    try {
      await prisma.$disconnect();
    } catch {
      // El error original ya se imprimió y es el que guía la operación.
    }
    process.exit(1);
  });

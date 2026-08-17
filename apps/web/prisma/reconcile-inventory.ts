/**
 * Reconciliación de inventario contra una base PostgreSQL REAL — SOLO LECTURA.
 *
 * Contrasta la columna `lots.onHand` contra los movimientos que deberían
 * explicarla y lista los lotes donde las dos cuentan cosas distintas.
 *
 * NO ESCRIBE NADA. Es lo contrario de `db:verify`, que arranca borrando media
 * base y por eso solo sirve contra un entorno descartable. Este está pensado
 * justo para lo que aquel no puede: mirar una copia RESTAURADA de producción
 * antes de un cutover, sin dejar rastro.
 *
 *   DATABASE_URL=postgresql://... AUTH_SECRET=... \
 *     pnpm --filter @drogueria/web db:reconcile
 *
 * Acota a un producto con `--product=<id>`. Sale con código 1 si encuentra
 * algo, para que un runbook o una tarea programada puedan encadenar.
 */
import { prisma } from "@/lib/db/prisma";
import {
  formatReconciliationReport,
  reconcileInventory,
} from "@/server/services/inventory-reconciliation.service";

function readProductFilter(): string | undefined {
  const flag = process.argv.find((arg) => arg.startsWith("--product="));
  return flag ? flag.slice("--product=".length) : undefined;
}

async function main() {
  const productId = readProductFilter();

  const report = await reconcileInventory({ ...(productId ? { productId } : {}) });
  console.log(formatReconciliationReport(report));

  if (!report.healthy) {
    console.log(
      "\nUn lote anterior al ledger aparece como COLUMN_DRIFT y está bien que\n" +
        "aparezca: su stock no lo explica ningún movimiento porque el ledger\n" +
        "todavía no existía. Esa lista es el trabajo pendiente del cutover.",
    );
  }

  return report.healthy;
}

main()
  .then(async (healthy) => {
    await prisma.$disconnect();
    process.exit(healthy ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

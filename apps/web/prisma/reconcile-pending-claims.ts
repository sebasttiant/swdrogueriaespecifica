/**
 * Reclama pendientes abiertos cuya promesa supera el stock físico.
 *
 *   docker compose run --rm --no-deps repair-claims --actor=<user id>
 *   docker compose run --rm --no-deps repair-claims --actor=<user id> --apply
 *
 * Sin `--apply` solo lista. Con `--apply` escribe en la misma transacción por
 * producto (auditoría incluida).
 */
import { prisma } from "@/lib/db/prisma";
import { recordAuditInTransaction } from "@/server/services/transactional-audit.service";
import { reconcilePendingClaimsForProduct } from "@/server/services/pending-claim-reconcile.service";

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const flag = process.argv.find((arg) => arg.startsWith(prefix));
  return flag ? flag.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const actorId = readFlag("actor");
  if (!actorId) {
    throw new Error("Falta --actor=<user id>.");
  }
  const apply = process.argv.includes("--apply");

  const overClaimed = await prisma.$queryRaw<
    { productId: string; ready: number; stock: number }[]
  >`
    SELECT pe."productId" AS "productId",
           sum(pe."inventoryReadyQuantity")::int AS ready,
           coalesce((
             SELECT sum(b.quantity)::int
             FROM product_batches b
             WHERE b."productId" = pe."productId"
               AND b.status = 'DISPONIBLE'
           ), 0) AS stock
      FROM pendings pe
     WHERE pe.status NOT IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL')
       AND pe."inventoryReadyQuantity" > 0
     GROUP BY pe."productId"
    HAVING sum(pe."inventoryReadyQuantity") >
           coalesce((
             SELECT sum(b.quantity)
             FROM product_batches b
             WHERE b."productId" = pe."productId"
               AND b.status = 'DISPONIBLE'
           ), 0)
     ORDER BY pe."productId"
  `;

  console.log(
    apply
      ? `Aplicando reclamo en ${overClaimed.length} producto(s)…`
      : `DRY-RUN: ${overClaimed.length} producto(s) con promesa > stock.`,
  );

  for (const row of overClaimed) {
    if (!apply) {
      console.log(
        `- product ${row.productId}: ready=${row.ready} stock=${row.stock}`,
      );
      continue;
    }

    const result = await prisma.$transaction((tx) =>
      reconcilePendingClaimsForProduct(tx, {
        productId: row.productId,
        actorId,
        writeAudit: recordAuditInTransaction,
        reason: "Ops reconcile: pending claims exceed physical stock",
      }),
    );
    console.log(
      `- product ${row.productId}: stock=${result.physicalStock} clamped=${result.clampedPendingIds.length}`,
    );
  }
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
      // already printed
    }
    process.exit(1);
  });

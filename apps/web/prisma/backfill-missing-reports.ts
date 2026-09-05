/**
 * Traslada los reportes históricos de vendedor a la cola accionable "Por pedir".
 *
 * POR QUÉ EXISTE. Hasta el 2026-10-04 un reporte nacía en `PENDING_REVIEW` y
 * gerencia tenía que aprobarlo para que recién entonces apareciera en "Por
 * pedir". Ese paso se eliminó: ahora `submitMissingReport` crea el faltante en
 * la misma transacción. Los reportes anteriores al cambio quedarían varados en
 * un buzón que ya nadie mira, así que este guion los pasa al circuito nuevo.
 *
 * NO BORRA NADA. Los reportes se conservan enteros —quién reportó, cuándo, con
 * qué nombre— y solo cambian de estado a LINKED apuntando al faltante que los
 * representa. Un reporte es evidencia histórica y sigue estando disponible para
 * auditoría después de la migración.
 *
 * USO:
 *
 *   # 1. Inspeccionar: NO escribe nada, imprime exactamente qué haría.
 *   DATABASE_URL=postgresql://... pnpm --filter @drogueria/web db:backfill:reportes
 *
 *   # 2. Aplicar, una vez revisado el informe de arriba.
 *   DATABASE_URL=postgresql://... pnpm --filter @drogueria/web db:backfill:reportes -- --apply
 *
 *   # 3. Verificar: el conteo pendiente tiene que quedar en 0.
 *   SELECT count(*) FROM missing_reports WHERE status = 'PENDING_REVIEW';
 *
 * IDEMPOTENTE. Correrlo dos veces no duplica nada: la segunda corrida no
 * encuentra reportes en `PENDING_REVIEW` y no hace nada. Si se interrumpe a
 * mitad, cada grupo se procesó o no se procesó —nunca a medias—, así que
 * recuperarse es volver a correrlo.
 *
 * ATÓMICO POR GRUPO. Cada nombre normalizado se resuelve en su propia
 * transacción: producto provisional, faltante y vinculación de sus reportes
 * entran juntos o no entra ninguno. Un grupo que falle no arrastra a los demás,
 * y el informe final dice cuáles fallaron.
 *
 * NO importa `@/lib/db/prisma` por el mismo motivo que `preflight-laboratory-identity`:
 * ese módulo valida el entorno completo de la aplicación (exige `AUTH_SECRET`),
 * y un guion de datos no tiene por qué pedir el secreto de sesión.
 */
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../lib/generated/prisma/client";

const EXIT_OK = 0;
const EXIT_FAILURES = 1;
const EXIT_UNVERIFIABLE = 2;

// El mismo 1 que usan el alta manual y `submitMissingReport`. No puede ser 0: el
// cierre FIFO trata `quantity <= disponible` como "cubierto", así que un 0
// cerraría el faltante con cualquier entrada de inventario.
const BACKFILL_MISSING_ITEM_QUANTITY = 1;

const BACKFILL_NOTE = "Reportado por vendedor (traslado histórico)";

type GroupPlan = {
  normalizedName: string;
  displayName: string;
  reportCount: number;
};

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("ERROR: falta DATABASE_URL. No se pudo inspeccionar nada.");
    return EXIT_UNVERIFIABLE;
  }

  const apply = process.argv.includes("--apply");

  const client = new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 10_000,
    }),
  });

  try {
    // Un grupo por nombre normalizado: es la unidad que el buzón mostraba y la
    // que se convierte en UN faltante. Convertir reporte por reporte generaría
    // cuatro filas idénticas en "Por pedir" para el mismo producto.
    const groups = await client.missingReport.groupBy({
      by: ["normalizedName"],
      where: { status: "PENDING_REVIEW" },
      _count: { _all: true },
    });

    if (groups.length === 0) {
      console.log("No hay reportes en PENDING_REVIEW. Nada que trasladar.");
      return EXIT_OK;
    }

    // El nombre que se muestra es el ORIGINAL del reporte más reciente, tal como
    // lo escribió el vendedor. El normalizado sirve para agrupar y nadie lo lee.
    const plans: GroupPlan[] = [];
    for (const group of groups) {
      const latest = await client.missingReport.findFirst({
        where: { normalizedName: group.normalizedName, status: "PENDING_REVIEW" },
        orderBy: { createdAt: "desc" },
        select: { rawName: true },
      });
      plans.push({
        normalizedName: group.normalizedName,
        displayName: latest?.rawName ?? group.normalizedName,
        reportCount: group._count._all,
      });
    }

    const totalReports = plans.reduce((sum, plan) => sum + plan.reportCount, 0);
    console.log(
      `${plans.length} grupo(s) con ${totalReports} reporte(s) en PENDING_REVIEW:\n`,
    );
    for (const plan of plans) {
      console.log(`  · "${plan.displayName}" — ${plan.reportCount} reporte(s)`);
    }

    if (!apply) {
      console.log(
        "\nMODO INSPECCIÓN: no se escribió nada.\n" +
          "Para aplicarlo, repetí el comando agregando  -- --apply",
      );
      return EXIT_OK;
    }

    console.log("\nAplicando...\n");
    let migrated = 0;
    let reused = 0;
    const failures: string[] = [];

    for (const plan of plans) {
      try {
        const result = await client.$transaction(async (tx) => {
          const product = await tx.product.upsert({
            where: { provisionalNormalizedName: plan.normalizedName },
            update: {},
            create: {
              code: `PROV-${plan.normalizedName}`,
              name: plan.displayName.trim(),
              unit: "unidad",
              minStock: 0,
              reorderQty: 0,
              needsReview: true,
              provisionalNormalizedName: plan.normalizedName,
            },
          });

          // Si ya hay un faltante accionable para ese producto se reusa: el
          // traslado no puede duplicar lo que gerencia ya tiene en la cola.
          const existing = await tx.missingItem.findFirst({
            where: { productId: product.id, status: "FALTANTE" },
            orderBy: { createdAt: "asc" },
            select: { id: true },
          });

          const missingItem =
            existing ??
            (await tx.missingItem.create({
              data: {
                productId: product.id,
                quantity: BACKFILL_MISSING_ITEM_QUANTITY,
                note: BACKFILL_NOTE,
              },
              select: { id: true },
            }));

          // CAS sobre `status`: solo se tocan los que siguen PENDING_REVIEW. Si
          // otro proceso resolvió alguno mientras tanto, esa fila no coincide y
          // su decisión no se pisa.
          const { count } = await tx.missingReport.updateMany({
            where: { normalizedName: plan.normalizedName, status: "PENDING_REVIEW" },
            data: {
              status: "LINKED",
              linkedProductId: product.id,
              linkedMissingItemId: missingItem.id,
            },
          });

          return { linked: count, reusedItem: existing !== null };
        });

        migrated += result.linked;
        if (result.reusedItem) reused += 1;
        console.log(
          `  OK  "${plan.displayName}" — ${result.linked} reporte(s)` +
            (result.reusedItem ? " (enganchados a un faltante existente)" : ""),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`${plan.displayName}: ${detail}`);
        console.error(`  FALLÓ  "${plan.displayName}" — ${detail}`);
      }
    }

    console.log(
      `\nTrasladados ${migrated} reporte(s). ` +
        `${reused} grupo(s) se engancharon a un faltante que ya existía.`,
    );

    if (failures.length > 0) {
      console.error(
        `\n${failures.length} grupo(s) fallaron y NO se trasladaron. ` +
          "Los demás sí: volver a correr el guion reintenta solo los que faltan.",
      );
      return EXIT_FAILURES;
    }

    return EXIT_OK;
  } catch (error) {
    console.error("ERROR inesperado:", error);
    return EXIT_UNVERIFIABLE;
  } finally {
    await client.$disconnect();
  }
}

main().then((code) => {
  process.exitCode = code;
});

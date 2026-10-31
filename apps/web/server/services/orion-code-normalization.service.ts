import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import { canonicalOrionCode, orionNumericCore } from "@/server/domain/catalog/orion-code";
import {
  recordAuditInTransaction,
  type TransactionalAuditWriter,
} from "@/server/services/transactional-audit.service";

// --------------------------------------------------------------------------
// Lleva los códigos de Orión ya cargados a su forma canónica — DRY-RUN POR
// DEFECTO.
//
// Es la contraparte histórica de `normalizeOrionCode`: esa impide que nazcan
// más grafías, esta arregla las que ya están. Las dos tienen que salir juntas.
// Desplegar la primera sin correr la segunda deja al sistema guardando
// `A20956` mientras el catálogo todavía dice `a-20956`, y la búsqueda exacta
// deja de encontrar lo que antes encontraba.
//
// Hace UNA cosa y se niega a hacer la otra:
//
//   renombra   cuando el código canónico está libre. Es mecánico: el producto
//              es el mismo, cambia cómo se escribe su identidad.
//   NO fusiona cuando el canónico ya lo tiene otro producto. Ahí hay dos filas
//              que son el mismo producto de Orión, y decidir cuál sobrevive
//              exige mirar stock, pendientes y faltantes de cada una. Eso es
//              trabajo de `repair-product-identity`, con su manifiesto
//              revisado por una persona.
//
// Esa frontera no es prolijidad: fusionar mal junta dos inventarios en uno y
// no se puede deshacer.
// --------------------------------------------------------------------------

export type NormalizationPlanEntry = {
  productId: string;
  name: string;
  currentCode: string;
  canonicalCode: string;
};

export type NormalizationConflict = {
  /** El número de Orión que más de un producto se disputa. */
  core: string;
  /** Las filas que lo comparten, con el código tal como está hoy. */
  products: { productId: string; name: string; currentCode: string }[];
};

export type NormalizationReport = {
  /** Renombres que se pueden aplicar sin tocar a nadie más. */
  renames: NormalizationPlanEntry[];
  /** Grupos que exigen una decisión humana: quedan intactos. */
  conflicts: NormalizationConflict[];
  /** Ya estaban en forma canónica. */
  untouched: number;
  applied: boolean;
};

type CodedProduct = {
  id: string;
  name: string;
  orionCode: string;
};

/**
 * Calcula el plan y, solo con `apply`, lo escribe.
 *
 * Cada renombre va en su propia transacción con su asiento de auditoría: si
 * uno falla —por ejemplo porque alguien tomó el código en el medio—, los
 * anteriores quedan hechos y el informe dice exactamente dónde se cortó. Una
 * transacción única sobre 751 filas obligaría a repetir todo por un solo
 * conflicto.
 */
export async function normalizeOrionCodes(
  options: { apply?: boolean; actorId: string },
  deps: { writeAudit?: TransactionalAuditWriter } = {},
): Promise<NormalizationReport> {
  const writeAudit = deps.writeAudit ?? recordAuditInTransaction;
  const apply = options.apply === true;

  const products = (await prisma.product.findMany({
    where: { active: true, orionCode: { not: null } },
    select: { id: true, name: true, orionCode: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })) as CodedProduct[];

  // Agrupar por número ANTES de planear: un renombre solo es seguro cuando su
  // número no lo reclama nadie más.
  const byCore = new Map<string, CodedProduct[]>();
  for (const product of products) {
    const core = orionNumericCore(product.orionCode);
    const group = byCore.get(core);
    if (group) group.push(product);
    else byCore.set(core, [product]);
  }

  const renames: NormalizationPlanEntry[] = [];
  const conflicts: NormalizationConflict[] = [];
  let untouched = 0;

  for (const [core, group] of byCore) {
    if (group.length > 1) {
      conflicts.push({
        core,
        products: group.map((product) => ({
          productId: product.id,
          name: product.name,
          currentCode: product.orionCode,
        })),
      });
      continue;
    }

    const product = group[0];
    if (!product) continue;
    const canonical = canonicalOrionCode(product.orionCode);
    if (canonical === product.orionCode) {
      untouched += 1;
      continue;
    }
    renames.push({
      productId: product.id,
      name: product.name,
      currentCode: product.orionCode,
      canonicalCode: canonical,
    });
  }

  if (!apply) return { renames, conflicts, untouched, applied: false };

  for (const entry of renames) {
    await prisma.$transaction(async (tx) => {
      // Compare-and-set sobre el código que planeamos: si cambió desde que se
      // calculó el plan, esta fila se salta en vez de pisar lo que haya.
      const { count } = await tx.product.updateMany({
        where: { id: entry.productId, orionCode: entry.currentCode },
        data: {
          orionCode: entry.canonicalCode,
          identityVersion: { increment: 1 },
        },
      });
      if (count !== 1) {
        throw new Error(
          `El producto ${entry.productId} cambió su código durante la normalización.`,
        );
      }

      await writeAudit(tx, {
        // Es una CORRECCIÓN de grafía sobre el mismo producto, no mudar un
        // código de un producto a otro: por eso `SKU_ORION_FIX` y no RELINK.
        action: AUDIT_ACTIONS.SKU_ORION_FIX,
        module: AUDIT_MODULES.PRODUCTOS,
        entity: "Product",
        entityId: entry.productId,
        before: { orionCode: entry.currentCode },
        after: { orionCode: entry.canonicalCode, reason: "ORION_CANONICAL_FORM" },
        context: { userId: options.actorId },
      });
    });
  }

  return { renames, conflicts, untouched, applied: true };
}

/** El informe en texto, con CADA id: es lo que se compara antes de aplicar. */
export function formatNormalizationReport(report: NormalizationReport): string {
  const lines: string[] = [
    `Estado: ${report.applied ? "aplicado" : "plan"}`,
    "",
    `ya canónicos: ${report.untouched}`,
    `renombres (${report.renames.length}):`,
  ];

  for (const entry of report.renames) {
    lines.push(`  - ${entry.productId}  ${entry.currentCode} -> ${entry.canonicalCode}`);
  }
  if (report.renames.length === 0) lines.push("  (ninguno)");

  lines.push("", `conflictos que NO se tocan (${report.conflicts.length}):`);
  for (const conflict of report.conflicts) {
    const copias = conflict.products.map((product) => product.currentCode).join(" | ");
    lines.push(`  - nº ${conflict.core}: ${copias}`);
  }
  if (report.conflicts.length === 0) lines.push("  (ninguno)");

  if (!report.applied) {
    lines.push("", "Dry-run: no se escribió nada. Usá --apply para ejecutar.");
  } else if (report.conflicts.length > 0) {
    lines.push(
      "",
      "Los conflictos quedaron intactos: son productos repetidos y cuál",
      "sobrevive lo decide una persona con `db:repair:identidad`.",
    );
  }

  return lines.join("\n");
}
